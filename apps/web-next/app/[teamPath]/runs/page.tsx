import { redirect } from 'next/navigation';

export default function Page({
  params,
}: {
  params: { teamPath: string };
}) {
  redirect(`/${params.teamPath}/settings?tab=runs`);
}
