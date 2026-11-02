import { createHash } from 'node:crypto';

export type ServerConfig = {
  apiKey: string; apiSecret: string; cano: string; product: string;
  htsId: string; env: 'prod' | 'vps'; password: string;
  tokenFile: string; accountTag: string;
};
export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const required = ['KIS_API_KEY', 'KIS_API_SECRET', 'KIS_CANO', 'KIS_ACNT_PRDT_CD', 'CT_PW'];
  const missing = required.filter(k => !env[k]);
  if (missing.length) throw new Error(`Missing server environment variables: ${missing.join(', ')}`);
  if (!/^\d{8}$/.test(env.KIS_CANO!) || !/^\d{2}$/.test(env.KIS_ACNT_PRDT_CD!)) throw new Error('Invalid server account configuration');
  const mode = env.KIS_ENV || 'prod';
  if (!['prod', 'real', 'vps', 'demo'].includes(mode)) throw new Error('KIS_ENV must be prod or vps');
  const kisEnv = mode === 'vps' || mode === 'demo' ? 'vps' : 'prod';
  return {
    apiKey: env.KIS_API_KEY!, apiSecret: env.KIS_API_SECRET!, cano: env.KIS_CANO!,
    product: env.KIS_ACNT_PRDT_CD!, password: env.CT_PW!, htsId: env.KIS_HTS_ID || '', env: kisEnv,
    tokenFile: env.KIS_TOKEN_STATE_PATH || '/tmp/kis_access_token_state.json',
    accountTag: createHash('sha256').update(`${kisEnv}:${env.KIS_CANO}:${env.KIS_ACNT_PRDT_CD}:${env.KIS_API_KEY}`).digest('hex'),
  };
}
