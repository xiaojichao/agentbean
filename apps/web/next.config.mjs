/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const serverUrl = process.env.NEXT_PUBLIC_AGENT_BEAN_SERVER_URL || 'http://localhost:4000';
    return [
      { source: '/socket.io/:path*', destination: `${serverUrl}/socket.io/:path*` },
    ];
  },
};
export default nextConfig;
