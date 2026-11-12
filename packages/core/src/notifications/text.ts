/**
 * Localised title/body templates for the automatic notification
 * kinds (v0.87c; v0.94c adds project-update).
 *
 * These live in core (not in the renderer locale files) because the
 * text is composed in the MAIN process — the renderer never sees the
 * notification, and main has no access to the renderer's i18n
 * dictionaries. The six locales match the app's supported locales
 * (vi/en/zh/ja/es/fr); an unknown locale falls back to English.
 *
 * Templates only interpolate the bot name, a tool name, or a short
 * error excerpt supplied by main (already redacted there — the error
 * text comes from the run result after `redactErrorText`, never a raw
 * provider message that could carry a key).
 */
import type { NotificationKind } from './service';

export type NotificationLocale = 'vi' | 'en' | 'zh' | 'ja' | 'es' | 'fr';

export interface NotificationTextVars {
  botName: string;
  /** Tool name for the approval kind (e.g. `shell_exec`). */
  tool?: string;
  /** Short error excerpt for the run-error kind. */
  error?: string;
}

export interface NotificationText {
  title: string;
  body: string;
}

const MAX_ERROR_EXCERPT_CHARS = 200;

type Templates = Record<NotificationKind, { title: string; body: string }>;

const TEMPLATES: Record<NotificationLocale, Templates> = {
  vi: {
    'run-complete': {
      title: '{bot} đã xong việc',
      body: 'Bot đã trả lời xong — mở bot để xem kết quả.',
    },
    approval: {
      title: '{bot} cần bạn duyệt',
      body: 'Tool {tool} đang chờ bạn duyệt.',
    },
    'run-error': {
      title: '{bot} gặp lỗi khi chạy',
      body: 'Lỗi: {error}',
    },
    'project-update': {
      title: 'Cập nhật project từ {bot}',
      body: 'Bot gửi digest tiến độ project — mở bot để xem.',
    },
  },
  en: {
    'run-complete': {
      title: '{bot} finished',
      body: 'The bot finished its reply — open the bot to see the result.',
    },
    approval: {
      title: '{bot} needs approval',
      body: 'Tool {tool} is waiting for your approval.',
    },
    'run-error': {
      title: '{bot} ran into an error',
      body: 'Error: {error}',
    },
    'project-update': {
      title: 'Project update from {bot}',
      body: 'The bot sent a project progress digest — open the bot to read it.',
    },
  },
  zh: {
    'run-complete': {
      title: '{bot} 已完成',
      body: '机器人已回复完成——打开机器人查看结果。',
    },
    approval: {
      title: '{bot} 需要你审批',
      body: '工具 {tool} 正在等待你的审批。',
    },
    'run-error': {
      title: '{bot} 运行时出错',
      body: '错误：{error}',
    },
    'project-update': {
      title: '来自 {bot} 的项目更新',
      body: '机器人发送了项目进度摘要——打开机器人查看。',
    },
  },
  ja: {
    'run-complete': {
      title: '{bot} が完了しました',
      body: 'ボットの返信が完了しました——開いて結果を確認してください。',
    },
    approval: {
      title: '{bot} が承認を待っています',
      body: 'ツール {tool} があなたの承認を待っています。',
    },
    'run-error': {
      title: '{bot} でエラーが発生しました',
      body: 'エラー: {error}',
    },
    'project-update': {
      title: '{bot} からのプロジェクト更新',
      body: 'ボットがプロジェクトの進捗ダイジェストを送信しました——開いてご覧ください。',
    },
  },
  es: {
    'run-complete': {
      title: '{bot} terminó',
      body: 'El bot terminó su respuesta: ábrelo para ver el resultado.',
    },
    approval: {
      title: '{bot} necesita aprobación',
      body: 'La herramienta {tool} está esperando tu aprobación.',
    },
    'run-error': {
      title: '{bot} encontró un error',
      body: 'Error: {error}',
    },
    'project-update': {
      title: 'Actualización de proyecto de {bot}',
      body: 'El bot envió un resumen del progreso del proyecto: ábrelo para leerlo.',
    },
  },
  fr: {
    'run-complete': {
      title: '{bot} a terminé',
      body: 'Le bot a terminé sa réponse — ouvrez-le pour voir le résultat.',
    },
    approval: {
      title: '{bot} attend votre approbation',
      body: "L'outil {tool} attend votre approbation.",
    },
    'run-error': {
      title: '{bot} a rencontré une erreur',
      body: 'Erreur : {error}',
    },
    'project-update': {
      title: 'Mise à jour de projet de {bot}',
      body: 'Le bot a envoyé un résumé de l’avancement du projet — ouvrez-le pour le lire.',
    },
  },
};

const SUPPORTED_LOCALES: readonly string[] = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];

function resolveLocale(locale: string | undefined): NotificationLocale {
  if (locale && (SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    return locale as NotificationLocale;
  }
  return 'en';
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => vars[key] ?? `{${key}}`);
}

/**
 * Build the title/body for an automatic notification. Never throws:
 * a missing tool falls back to a generic approval body, a missing
 * error falls back to a generic failure body.
 */
export function formatNotificationText(
  locale: string | undefined,
  kind: NotificationKind,
  vars: NotificationTextVars,
): NotificationText {
  const templates = TEMPLATES[resolveLocale(locale)][kind];
  const botName = vars.botName.trim().length > 0 ? vars.botName.trim() : 'open-bot';
  const tool = vars.tool && vars.tool.trim().length > 0 ? vars.tool.trim() : 'a tool';
  const error =
    vars.error && vars.error.trim().length > 0
      ? vars.error.trim().slice(0, MAX_ERROR_EXCERPT_CHARS)
      : 'unknown error';
  return {
    title: fill(templates.title, { bot: botName }),
    body: fill(templates.body, { bot: botName, tool, error }),
  };
}
