// وضع الحماية (Sandbox): تشغيل أوامر الوكيل داخل حاوية عند توفّر docker/podman،
// فلا يستطيع أمر ما لمس ملفاتك خارج المشروع ولا نظام جهازك.
//
// السياسة:
//  - 'off'    : بلا حماية (الافتراضي — نفس ما كانت عليه الأداة).
//  - 'auto'   : حماية إن توفّر محرّك حاويات، وإلا تنفيذ محلي مع تنبيه مرة واحدة.
//  - 'docker' : يطلب الحماية صراحةً — وإن لم يتوفر docker يفشل الأمر برسالة واضحة
//               (لا نخفض الحماية بصمت أبداً، فالطلب كان أمنياً).
import { execFile } from 'node:child_process';

export type SandboxMode = 'off' | 'auto' | 'docker' | 'podman';
export type ContainerEngine = 'docker' | 'podman';

export interface SandboxSettings {
  mode: SandboxMode;
  /** صورة الحاوية (افتراضي node:22-bookworm-slim) */
  image: string;
  /** السماح بالشبكة داخل الحاوية (مطلوب لتثبيت الحزم) */
  network: boolean;
  /** وسائط إضافية لـdocker run، مثل --memory=2g --cpus=2 */
  extraArgs: string;
}

export const SANDBOX_DEFAULTS: SandboxSettings = { mode: 'off', image: 'node:22-bookworm-slim', network: true, extraArgs: '' };

export interface EngineInfo {
  available: boolean;
  engine?: ContainerEngine;
  version?: string;
  reason?: string;
}

const cache = new Map<string, { at: number; info: EngineInfo }>();

/** يقرأ إصدار المحرّك (docker version / podman --version) — مع كاش قصير */
export function detectEngine(engine: ContainerEngine, timeoutMs = 4000): Promise<EngineInfo> {
  const key = `detect:${engine}`;
  const c = cache.get(key);
  if (c && Date.now() - c.at < 30_000) return Promise.resolve(c.info);

  return new Promise((resolve) => {
    const done = (info: EngineInfo) => {
      cache.set(key, { at: Date.now(), info });
      resolve(info);
    };
    const args = engine === 'docker' ? ['version', '--format', '{{.Server.Version}}'] : ['--version'];
    execFile(engine, args, { timeout: timeoutMs, windowsHide: true }, (err: any, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '');
        const reason = /ENOENT|not found/i.test(msg)
          ? `لم أجد ${engine} على هذا الجهاز.`
          : /Cannot connect|daemon|permission denied/i.test(msg)
            ? `${engine} موجود لكن خدمته لا تعمل أو لا تملك صلاحية الوصول إليها.`
            : `تعذّر تشغيل ${engine}: ${msg.split('\n')[0].slice(0, 120)}`;
        return done({ available: false, engine, reason });
      }
      const version = parseEngineVersion(String(stdout ?? ''));
      done({ available: true, engine, version });
    });
  });
}

/** يستخرج رقم إصدار من مخرجات docker/podman (دالة نقية للاختبار) */
export function parseEngineVersion(out: string): string {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(out);
  return m ? m[1] : out.trim().split('\n')[0].slice(0, 40);
}

/** أي محرّك يحتاجه الطلب؟ (auto = docker ثم podman) */
export function engineCandidates(mode: SandboxMode): ContainerEngine[] {
  if (mode === 'docker') return ['docker'];
  if (mode === 'podman') return ['podman'];
  if (mode === 'auto') return ['docker', 'podman'];
  return [];
}

export interface SandboxDecision {
  /** نفّذ داخل حاوية */
  sandboxed: boolean;
  engine?: ContainerEngine;
  /** سبب عدم التشغيل داخل حاوية (يُعرض للمستخدم/النموذج) */
  reason?: string;
  /** خطأ يمنع التنفيذ المحلي أصلاً (طلب صريح بلا محرّك) */
  fatal?: boolean;
}

/**
 * قرار التنفيذ: قرار نقي يُختبر وحده.
 * mode=off → محلي. auto → حاوية إن توفّرت وإلا محلي بسبب واضح.
 * docker/podman → حاوية إن توفّرت، وإلا خطأ قاطع (لا نخفض الحماية بصمت).
 */
export function decideSandbox(mode: SandboxMode, engines: Partial<Record<ContainerEngine, EngineInfo>>): SandboxDecision {
  if (mode === 'off') return { sandboxed: false };
  const wanted = engineCandidates(mode);
  for (const e of wanted) {
    const info = engines[e];
    if (info?.available) return { sandboxed: true, engine: e };
  }
  const first = engines[wanted[0]]?.reason ?? `لم أجد ${wanted[0]} على هذا الجهاز.`;
  if (mode === 'auto') return { sandboxed: false, reason: `لم أفعّل الحماية: ${first}` };
  return { sandboxed: false, reason: `${first} الأمر المطلوب لم يُنفّذ لأنك طلبت الحماية صراحةً.`, fatal: true };
}

/** وسائط docker run (منفصلة في مصفوفة — لا تركيب نصي) */
export function sandboxArgs(engine: ContainerEngine, root: string, image: string, o: { network: boolean; extraArgs: string }): string[] {
  const args = ['run', '--rm', '--init', '-i'];
  if (!o.network) args.push('--network', 'none');
  // ملفات تُنشأ داخل الحاوية تبقى مملوكة للمستخدم لا root
  if (process.platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    args.push('--user', `${uid}:${gid}`);
  }
  args.push('--tmpfs', '/tmp', '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/.npm');
  args.push('-e', 'CI=1', '-e', 'FORCE_COLOR=0');
  args.push('-v', `${root}:/work`, '-w', '/work');
  for (const a of splitExtraArgs(o.extraArgs)) args.push(a);
  args.push(image, 'sh', '-lc');
  void engine; // نفس الوسائط لمحرّكَي docker وpodman
  return args;
}

/** يقسّم وسائط المستخدم الإضافية إلى مصفوفة (نقي) */
export function splitExtraArgs(raw: string): string[] {
  return String(raw ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

/** أمر التنفيذ داخل الحاوية (نص shell، وكل وسيط مقتبس على حدة) */
export function sandboxCommand(
  engine: ContainerEngine,
  root: string,
  command: string,
  s: Pick<SandboxSettings, 'image' | 'network' | 'extraArgs'>,
): string {
  const args = sandboxArgs(engine, root, s.image || SANDBOX_DEFAULTS.image, { network: s.network, extraArgs: s.extraArgs });
  return `${engine}${args.map((a) => ` ${quoteArg(a)}`).join('')} ${quoteArg(String(command))}`;
}

/** اقتباس وسيط shell بأمان (نقي) */
export function quoteArg(a: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) return a;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

/** كل ما يفعله الوكيل: قرار + أمر + ملاحظة للمستخدم */
export function prepareSandbox(
  s: SandboxSettings,
  engines: Partial<Record<ContainerEngine, EngineInfo>>,
  root: string,
  command: string,
): { command: string; sandboxed: boolean; note: string; fatal: boolean } {
  const d = decideSandbox(s.mode, engines);
  if (!d.sandboxed) {
    return {
      command,
      sandboxed: false,
      fatal: !!d.fatal,
      note: d.reason ? (d.fatal ? `وضع الحماية مطلوب لكن غير متاح: ${d.reason}` : `تنفيذ محلي (${d.reason})`) : '',
    };
  }
  const engine = d.engine!;
  return {
    command: sandboxCommand(engine, root, command, s),
    sandboxed: true,
    fatal: false,
    note: `تنفيذ داخل حاوية ${engine}${s.network ? '' : ' بلا شبكة'} (${s.image})`,
  };
}

/** نص الحالة لعرضه في /sandbox أو الإعدادات */
export function describeSandbox(s: SandboxSettings, engines: Partial<Record<ContainerEngine, EngineInfo>>): string {
  const modeAr = { off: 'معطّلة', auto: 'تلقائية', docker: 'Docker', podman: 'Podman' }[s.mode];
  const d = decideSandbox(s.mode, engines);
  if (s.mode === 'off') return `وضع الحماية: ${modeAr} — أوامر الوكيل تعمل على نظامك مباشرة. شغّله بـ/sandbox on.`;
  if (d.sandboxed) return `وضع الحماية: ${modeAr} — يعمل عبر ${d.engine} (صورة ${s.image}${s.network ? '' : ' · بلا شبكة'}).`;
  const head = d.fatal ? 'المحرّك غير متاح' : 'لم أفعّل الحماية';
  return `وضع الحماية: ${modeAr} — ${head}: ${d.reason}${d.fatal ? ' (الأوامر سترفض حتى يتوفر المحرّك)' : ' (ستُنفَّذ محلياً)'}`;
}

export const SANDBOX_CONFIG_TEMPLATE = {
  mode: 'auto' as SandboxMode,
  image: SANDBOX_DEFAULTS.image,
  network: true,
  extraArgs: '--memory=2g',
};
