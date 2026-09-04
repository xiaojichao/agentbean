import { createECDH } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [output, subject] = process.argv.slice(2);
if (!output || !subject || !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) {
  console.error('用法: node scripts/generate-web-push-keys.mjs <私密输出文件> <mailto:运维邮箱>');
  process.exit(1);
}
const key = createECDH('prime256v1');
key.generateKeys();
writeFileSync(resolve(output), [
  'AGENTBEAN_WEB_PUSH_PUBLIC_KEY=' + key.getPublicKey().toString('base64url'),
  'AGENTBEAN_WEB_PUSH_PRIVATE_KEY=' + key.getPrivateKey().toString('base64url'),
  'AGENTBEAN_WEB_PUSH_SUBJECT=' + subject,
  '',
].join('\n'), { mode: 0o600, flag: 'wx' });
console.log('已生成推送配置文件；私钥未输出到终端。请将文件内容配置到服务端 Secret，勿提交 Git。');
