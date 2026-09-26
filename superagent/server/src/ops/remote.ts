/**
 * Remote access wizard: which addresses this machine has (LAN, WireGuard/VPN), which one
 * the service listens on, and switching it. The service reads SUPERAGENT_HOST from
 * `~/.config/superagent/env` (its --host flag is dropped from the unit once), then restarts.
 * Anything but loopback makes every request need the token (see startServer).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

export class RemoteError extends Error {}

export interface RemoteAddress { readonly address: string; readonly iface: string; readonly kind: 'loopback' | 'vpn' | 'lan' | 'all' | 'other' }

const VPN = /^(wg|tun|tap|tailscale|zt|utun|dgx)/i

export function listAddresses(): RemoteAddress[] {
  const out: RemoteAddress[] = [{ address: '127.0.0.1', iface: 'lo', kind: 'loopback' }]
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (/^(docker|br-|veth|virbr)/.test(iface)) continue
      out.push({ address: a.address, iface, kind: VPN.test(iface) ? 'vpn' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) ? 'lan' : 'other' })
    }
  }
  out.push({ address: '0.0.0.0', iface: '*', kind: 'all' })
  return out
}

export interface RemotePaths { readonly envFile: string; readonly unitFile: string }
export const defaultRemotePaths = (): RemotePaths => ({
  envFile: join(homedir(), '.config', 'superagent', 'env'),
  unitFile: join(homedir(), '.config', 'systemd', 'user', 'superagent.service'),
})

export function readEnvValue(envFile: string, key: string): string | undefined {
  if (!existsSync(envFile)) return undefined
  return new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1]?.trim()
}

function setEnvValue(envFile: string, key: string, value: string): void {
  const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
  const line = `${key}=${value}`
  const next = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`
  writeFileSync(envFile, next, { mode: 0o600 })
}

/**
 * Point the service at `host`. Returns false when there is no service unit to change
 * (then the user restarts `sa serve --host …` by hand).
 */
export function setServiceHost(host: string, paths: RemotePaths = defaultRemotePaths(), reload = true): boolean {
  if (!listAddresses().some(a => a.address === host)) throw new RemoteError(`${host} is not an address of this machine`)
  if (!existsSync(paths.unitFile)) return false
  if (!readEnvValue(paths.envFile, 'SUPERAGENT_HUMAN_TOKEN')) throw new RemoteError('set a stable SUPERAGENT_HUMAN_TOKEN first (sa service install writes one), or the phone link breaks on every restart')
  setEnvValue(paths.envFile, 'SUPERAGENT_HOST', host)
  const unit = readFileSync(paths.unitFile, 'utf8')
  const fixed = unit.replace(/^(ExecStart=.*?) --host \S+/m, '$1')
  if (fixed !== unit) {
    writeFileSync(paths.unitFile, fixed)
    if (reload) execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
  }
  return true
}
