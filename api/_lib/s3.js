// Shared S3 client for the report-serving routes (report/[card].js, report/raw.js).
// REPORTS_BUCKET is a plain Lambda env var (not a secret) - just a bucket name, not
// sensitive on its own; access is controlled by the Lambda's IAM role, not by keeping
// the name private.
const { S3Client } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({});
const REPORTS_BUCKET = process.env.REPORTS_BUCKET || 'mcaff-cls-reports';

module.exports = { s3Client, REPORTS_BUCKET };
