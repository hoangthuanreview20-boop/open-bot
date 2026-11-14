#!/usr/bin/env python3
"""Insert v1.01 T2 hook event descriptions (shown under each event
checkbox in the hook form) into all 6 locale files.

Inserted right after "settings.hooksTestGateCommandsHint"; key order
does not matter to the i18n tests, which only require identical key
sets across locales.
"""
import json
from collections import OrderedDict

NEW = {
    "en": {
        "settings.hooksEventDescPreToolUse": "Before a tool call — block it or rewrite its arguments.",
        "settings.hooksEventDescPostToolUse": "After a tool call — inspect or rewrite its result.",
        "settings.hooksEventDescSessionStart": "When a session starts.",
        "settings.hooksEventDescSessionEnd": "When a session ends.",
        "settings.hooksEventDescStop": "When the agent stops (end of a turn).",
        "settings.hooksEventDescSubagentStart": "Before a subagent starts — block it or add context.",
        "settings.hooksEventDescSubagentStop": "When a subagent stops — block it to send it back to fix its work.",
        "settings.hooksEventDescPreCompact": "Before context compaction — block it to skip the round.",
        "settings.hooksEventDescPostCompact": "After context compaction — inspect the summary or revert it.",
        "settings.hooksEventDescUserPromptSubmit": "When the user submits a prompt — block it or add context.",
    },
    "vi": {
        "settings.hooksEventDescPreToolUse": "Trước khi gọi tool — chặn hoặc sửa lại tham số.",
        "settings.hooksEventDescPostToolUse": "Sau khi gọi tool — xem hoặc sửa lại kết quả.",
        "settings.hooksEventDescSessionStart": "Khi phiên làm việc bắt đầu.",
        "settings.hooksEventDescSessionEnd": "Khi phiên làm việc kết thúc.",
        "settings.hooksEventDescStop": "Khi agent dừng (cuối một lượt).",
        "settings.hooksEventDescSubagentStart": "Trước khi subagent chạy — chặn hoặc thêm context.",
        "settings.hooksEventDescSubagentStop": "Khi subagent dừng — chặn để gửi nó quay lại sửa.",
        "settings.hooksEventDescPreCompact": "Trước khi nén context — chặn để bỏ qua vòng nén.",
        "settings.hooksEventDescPostCompact": "Sau khi nén context — xem tóm tắt hoặc hoàn tác.",
        "settings.hooksEventDescUserPromptSubmit": "Khi user gửi prompt — chặn hoặc thêm context.",
    },
    "es": {
        "settings.hooksEventDescPreToolUse": "Antes de llamar a una herramienta: bloquéala o reescribe sus argumentos.",
        "settings.hooksEventDescPostToolUse": "Después de llamar a una herramienta: inspecciona o reescribe su resultado.",
        "settings.hooksEventDescSessionStart": "Cuando empieza una sesión.",
        "settings.hooksEventDescSessionEnd": "Cuando termina una sesión.",
        "settings.hooksEventDescStop": "Cuando el agente se detiene (fin de un turno).",
        "settings.hooksEventDescSubagentStart": "Antes de que empiece un subagente: bloquéalo o añade contexto.",
        "settings.hooksEventDescSubagentStop": "Cuando un subagente se detiene: bloquéalo para devolverlo a corregir su trabajo.",
        "settings.hooksEventDescPreCompact": "Antes de compactar el contexto: bloquéalo para saltar la ronda.",
        "settings.hooksEventDescPostCompact": "Después de compactar el contexto: revisa el resumen o revierte.",
        "settings.hooksEventDescUserPromptSubmit": "Cuando el usuario envía un prompt: bloquéalo o añade contexto.",
    },
    "fr": {
        "settings.hooksEventDescPreToolUse": "Avant l'appel d'un outil : le bloquer ou réécrire ses arguments.",
        "settings.hooksEventDescPostToolUse": "Après l'appel d'un outil : inspecter ou réécrire son résultat.",
        "settings.hooksEventDescSessionStart": "Quand une session commence.",
        "settings.hooksEventDescSessionEnd": "Quand une session se termine.",
        "settings.hooksEventDescStop": "Quand l'agent s'arrête (fin d'un tour).",
        "settings.hooksEventDescSubagentStart": "Avant le démarrage d'un sous-agent : le bloquer ou ajouter du contexte.",
        "settings.hooksEventDescSubagentStop": "Quand un sous-agent s'arrête : le bloquer pour le renvoyer corriger son travail.",
        "settings.hooksEventDescPreCompact": "Avant la compaction du contexte : la bloquer pour sauter le tour.",
        "settings.hooksEventDescPostCompact": "Après la compaction du contexte : examiner le résumé ou l'annuler.",
        "settings.hooksEventDescUserPromptSubmit": "Quand l'utilisateur envoie un prompt : le bloquer ou ajouter du contexte.",
    },
    "ja": {
        "settings.hooksEventDescPreToolUse": "ツール呼び出し前 — ブロック、または引数を書き換えます。",
        "settings.hooksEventDescPostToolUse": "ツール呼び出し後 — 結果を確認、または書き換えます。",
        "settings.hooksEventDescSessionStart": "セッション開始時。",
        "settings.hooksEventDescSessionEnd": "セッション終了時。",
        "settings.hooksEventDescStop": "エージェント停止時（1ターンの終わり）。",
        "settings.hooksEventDescSubagentStart": "サブエージェント開始前 — ブロック、またはコンテキストを追加します。",
        "settings.hooksEventDescSubagentStop": "サブエージェント停止時 — ブロックして修正に戻します。",
        "settings.hooksEventDescPreCompact": "コンテキスト圧縮前 — ブロックしてその回をスキップします。",
        "settings.hooksEventDescPostCompact": "コンテキスト圧縮後 — 要約を確認、または元に戻します。",
        "settings.hooksEventDescUserPromptSubmit": "ユーザーがプロンプトを送信したとき — ブロック、またはコンテキストを追加します。",
    },
    "zh": {
        "settings.hooksEventDescPreToolUse": "调用工具之前——阻止调用或改写其参数。",
        "settings.hooksEventDescPostToolUse": "调用工具之后——检查或改写其结果。",
        "settings.hooksEventDescSessionStart": "会话开始时。",
        "settings.hooksEventDescSessionEnd": "会话结束时。",
        "settings.hooksEventDescStop": "代理停止时（一轮结束）。",
        "settings.hooksEventDescSubagentStart": "子代理启动之前——阻止或添加上下文。",
        "settings.hooksEventDescSubagentStop": "子代理停止时——阻止它，让它回去修复工作。",
        "settings.hooksEventDescPreCompact": "压缩上下文之前——阻止以跳过本轮压缩。",
        "settings.hooksEventDescPostCompact": "压缩上下文之后——查看摘要或撤销。",
        "settings.hooksEventDescUserPromptSubmit": "用户提交提示词时——阻止或添加上下文。",
    },
}

ANCHOR = "settings.hooksTestGateCommandsHint"

for code, additions in NEW.items():
    path = f"apps/desktop/src/renderer/i18n/locales/{code}.json"
    with open(path, encoding="utf-8") as f:
        data = json.load(f, object_pairs_hook=OrderedDict)
    assert set(additions) == set(NEW["en"]), f"{code} key set differs from en"
    for k in additions:
        assert k not in data, f"{code} already has {k}"
    out = OrderedDict()
    for k, v in data.items():
        out[k] = v
        if k == ANCHOR:
            for nk, nv in additions.items():
                out[nk] = nv
    assert len(out) == len(data) + len(additions), code
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(code, len(out), "keys")
