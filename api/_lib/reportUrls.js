// Signs links to /reports/* on OUR OWN CloudFront domain, instead of generating S3
// presigned URLs pointing at S3's own domain. Necessary because the dashboard's own
// front-end code (index.html's onIframeLoaded) reaches into the report iframe's
// document directly to mirror its internal tab bar - browsers only allow that when
// the iframe content is same-origin as the parent page. A redirect straight to S3's
// domain broke that (SecurityError: Blocked a frame with origin ... from accessing a
// cross-origin frame) - keeping the report on the same CloudFront domain as the rest
// of the site, just gated by a signature instead of being a plain public path, fixes
// it while still keeping the file out of Lambda's own response (still well over
// Lambda/API Gateway's payload limit).
const { getSignedUrl } = require('@aws-sdk/cloudfront-signer');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({});
let cached = null;

async function getSigningKey() {
  if (cached) return cached;
  const secretName = process.env.CLOUDFRONT_SIGNING_SECRET_NAME || 'mcaff-cls/cloudfront-signing';
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
  cached = JSON.parse(SecretString);
  return cached;
}

// path e.g. "reports/mcaffeine.html" - matches the key layout the refresh workflow
// already uploads to (see .github/workflows/refresh.yml's "Upload reports to S3" step).
//
// REPORTS_BASE_URL is deliberately separate from PUBLIC_BASE_URL: the latter is the
// frontend's own public origin (used for OAuth redirect_uri construction - see
// auth/[action].js's publicBaseUrl()), which now points at Amplify. This one must stay
// pointed at the CloudFront distribution that actually fronts the reports S3 bucket
// (d1lqcvzr613wr4.cloudfront.net) - the two used to be the same domain back when
// CloudFront also served the frontend, but split apart once the frontend moved to
// Amplify. Signing a URL against the wrong one produces a link Amplify doesn't know how
// to serve (404), since Amplify has no /reports/* route of its own.
async function signedReportUrl(path, expiresInSeconds = 60) {
  const { KEY_PAIR_ID, PRIVATE_KEY } = await getSigningKey();
  const base = process.env.REPORTS_BASE_URL || process.env.PUBLIC_BASE_URL;
  const url = `${base}/${path}`;
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return getSignedUrl({ url, keyPairId: KEY_PAIR_ID, privateKey: PRIVATE_KEY, dateLessThan: new Date(expires * 1000) });
}

module.exports = { signedReportUrl };
