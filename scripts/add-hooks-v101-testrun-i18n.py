#!/usr/bin/env python3
"""Insert v1.01 T2 hook test-run i18n strings into all 6 locale files.

Keys are inserted right after "settings.hooksLogTimeout" (kept in the
settings.* region); key order does not matter to the i18n tests, which
only require identical key sets across locales.
"""
import json
from collections import OrderedDict

NEW = {
    "en": {
        "settings.hooksCommandTest": "Test run",
        "settings.hooksCommandTesting": "Testing…",
        "settings.hooksCommandTestTitle": "Test run: {name}",
        "settings.hooksCommandTestEvent": "Event: {event}",
        "settings.hooksCommandTestDuration": "Duration: {ms}ms",
        "settings.hooksCommandTestExit": "Exit: {exit}",
        "settings.hooksCommandTestDecision": "Decision: {action}",
        "settings.hooksCommandTestCwd": "Ran in: {cwd}",
    },
    "vi": {
        "settings.hooksCommandTest": "Chạy thử",
        "settings.hooksCommandTesting": "Đang chạy thử…",
        "settings.hooksCommandTestTitle": "Chạy thử: {name}",
        "settings.hooksCommandTestEvent": "Event: {event}",
        "settings.hooksCommandTestDuration": "Thời gian: {ms}ms",
        "settings.hooksCommandTestExit": "Exit: {exit}",
        "settings.hooksCommandTestDecision": "Quyết định: {action}",
        "settings.hooksCommandTestCwd": "Chạy trong: {cwd}",
    },
    "es": {
        "settings.hooksCommandTest": "Probar",
        "settings.hooksCommandTesting": "Probando…",
        "settings.hooksCommandTestTitle": "Prueba: {name}",
        "settings.hooksCommandTestEvent": "Evento: {event}",
        "settings.hooksCommandTestDuration": "Duración: {ms} ms",
        "settings.hooksCommandTestExit": "Salida: {exit}",
        "settings.hooksCommandTestDecision": "Decisión: {action}",
        "settings.hooksCommandTestCwd": "Ejecutado en: {cwd}",
    },
    "fr": {
        "settings.hooksCommandTest": "Tester",
        "settings.hooksCommandTesting": "Test en cours…",
        "settings.hooksCommandTestTitle": "Test : {name}",
        "settings.hooksCommandTestEvent": "Événement : {event}",
        "settings.hooksCommandTestDuration": "Durée : {ms} ms",
        "settings.hooksCommandTestExit": "Code : {exit}",
        "settings.hooksCommandTestDecision": "Décision : {action}",
        "settings.hooksCommandTestCwd": "Exécuté dans : {cwd}",
    },
    "ja": {
        "settings.hooksCommandTest": "テスト実行",
        "settings.hooksCommandTesting": "テスト実行中…",
        "settings.hooksCommandTestTitle": "テスト実行: {name}",
        "settings.hooksCommandTestEvent": "イベント: {event}",
        "settings.hooksCommandTestDuration": "所要時間: {ms}ms",
        "settings.hooksCommandTestExit": "終了コード: {exit}",
        "settings.hooksCommandTestDecision": "決定: {action}",
        "settings.hooksCommandTestCwd": "実行ディレクトリ: {cwd}",
    },
    "zh": {
        "settings.hooksCommandTest": "试运行",
        "settings.hooksCommandTesting": "试运行中…",
        "settings.hooksCommandTestTitle": "试运行：{name}",
        "settings.hooksCommandTestEvent": "事件：{event}",
        "settings.hooksCommandTestDuration": "用时：{ms} 毫秒",
        "settings.hooksCommandTestExit": "退出码：{exit}",
        "settings.hooksCommandTestDecision": "决定：{action}",
        "settings.hooksCommandTestCwd": "运行目录：{cwd}",
    },
}

ANCHOR = "settings.hooksLogTimeout"

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
