import PublicSurveyClient from './PublicSurveyClient';

export const metadata = {
  title: 'Share your feedback',
};

export default function Page({ params }) {
  return <PublicSurveyClient token={params.token} />;
}
