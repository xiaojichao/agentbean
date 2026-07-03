import { redirect } from 'next/navigation';

export default function Page({
  params,
}: {
  params: { networkPath: string };
}) {
  redirect(`/${params.networkPath}/settings`);
}
