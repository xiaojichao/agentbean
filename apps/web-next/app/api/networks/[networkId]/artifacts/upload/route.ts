import { NextRequest } from 'next/server';
import { proxyArtifactUpload } from '../../../../_artifact-upload-proxy';

export async function POST(req: NextRequest, { params }: { params: { networkId: string } }) {
  return proxyArtifactUpload(req, params.networkId);
}
