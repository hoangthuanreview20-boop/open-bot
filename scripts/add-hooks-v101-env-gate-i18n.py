#!/usr/bin/env python3
"""Insert v1.01 T2 hook env-editor + multi-command-gate i18n strings.

Inserted right after "settings.hooksCommandTestCwd" (kept in the
settings.* region); key order does not matter to the i18n tests, which
only require identical key sets across locales.
"""
import json
from collections import OrderedDict

NEW = {
    "en": {
        "settings.hooksCommandEnvLabel": "Extra environment variables",
        "settings.hooksCommandEnvHint": "One KEY=VALUE per line. Secret-looking names (KEY, TOKEN, SECRET, PASSWORD, …) are not allowed — hooks never receive secrets.",
        "settings.hooksCommandEnvInvalid": "Env line must be KEY=VALUE with a valid variable name.",
        "settings.hooksCommandEnvSecret": "Env names that look like secrets (KEY, TOKEN, SECRET, PASSWORD, …) are not allowed.",
        "settings.hooksCommandEnvCount": "env: {keys}",
        "settings.hooksTestGateCommandsHint": "One command per line. Commands run in order and stop at the first failure, so the subagent gets one digest to fix at a time.",
    },
    "vi": {
        "settings.hooksCommandEnvLabel": "Biến môi trường thêm",
        "settings.hooksCommandEnvHint": "Mỗi dòng một cặp KEY=VALUE. Tên trông giống secret (KEY, TOKEN, SECRET, PASSWORD, …) không được phép — hook không bao giờ nhận secret.",
        "settings.hooksCommandEnvInvalid": "Dòng env phải có dạng KEY=VALUE với tên biến hợp lệ.",
        "settings.hooksCommandEnvSecret": "Tên env trông giống secret (KEY, TOKEN, SECRET, PASSWORD, …) không được phép.",
        "settings.hooksCommandEnvCount": "env: {keys}",
        "settings.hooksTestGateCommandsHint": "Mỗi dòng một lệnh. Các lệnh chạy tuần tự và dừng ở lệnh fail đầu tiên, để subagent nhận một bản tóm tắt lỗi để sửa mỗi lần.",
    },
    "es": {
        "settings.hooksCommandEnvLabel": "Variables de entorno adicionales",
        "settings.hooksCommandEnvHint": "Una línea por par KEY=VALUE. Los nombres que parecen secretos (KEY, TOKEN, SECRET, PASSWORD, …) no están permitidos: los hooks nunca reciben secretos.",
        "settings.hooksCommandEnvInvalid": "Cada línea de env debe ser KEY=VALUE con un nombre de variable válido.",
        "settings.hooksCommandEnvSecret": "Los nombres de env que parecen secretos (KEY, TOKEN, SECRET, PASSWORD, …) no están permitidos.",
        "settings.hooksCommandEnvCount": "env: {keys}",
        "settings.hooksTestGateCommandsHint": "Un comando por línea. Los comandos se ejecutan en orden y se detienen en el primer fallo, para que el subagente reciba un solo resumen de errores cada vez.",
    },
    "fr": {
        "settings.hooksCommandEnvLabel": "Variables d'environnement supplémentaires",
        "settings.hooksCommandEnvHint": "Une ligne par paire KEY=VALUE. Les noms qui ressemblent à des secrets (KEY, TOKEN, SECRET, PASSWORD, …) sont interdits : les hooks ne reçoivent jamais de secrets.",
        "settings.hooksCommandEnvInvalid": "Chaque ligne env doit être KEY=VALUE avec un nom de variable valide.",
        "settings.hooksCommandEnvSecret": "Les noms d'env qui ressemblent à des secrets (KEY, TOKEN, SECRET, PASSWORD, …) sont interdits.",
        "settings.hooksCommandEnvCount": "env : {keys}",
        "settings.hooksTestGateCommandsHint": "Un commande par ligne. Les commandes s'exécutent dans l'ordre et s'arrêtent au premier échec, pour que le sous-agent reçoive un seul résumé d'erreurs à la fois.",
    },
    "ja": {
        "settings.hooksCommandEnvLabel": "追加の環境変数",
        "settings.hooksCommandEnvHint": "1行に1つ KEY=VALUE。シークレットらしい名前（KEY、TOKEN、SECRET、PASSWORD など）は使えません。フックにシークレットは渡されません。",
        "settings.hooksCommandEnvInvalid": "env の行は有効な変数名の KEY=VALUE 形式である必要があります。",
        "settings.hooksCommandEnvSecret": "シークレットらしい env 名（KEY、TOKEN、SECRET、PASSWORD など）は使えません。",
        "settings.hooksCommandEnvCount": "env: {keys}",
        "settings.hooksTestGateCommandsHint": "1行に1コマンド。コマンドは順番に実行され、最初の失敗で停止します。サブエージェントは一度に1つのエラー要約を受け取ります。",
    },
    "zh": {
        "settings.hooksCommandEnvLabel": "额外环境变量",
        "settings.hooksCommandEnvHint": "每行一个 KEY=VALUE。看起来像密钥的名称（KEY、TOKEN、SECRET、PASSWORD 等）不允许使用——钩子永远不会收到密钥。",
        "settings.hooksCommandEnvInvalid": "env 行必须是合法变量名的 KEY=VALUE 格式。",
        "settings.hooksCommandEnvSecret": "看起来像密钥的 env 名称（KEY、TOKEN、SECRET、PASSWORD 等）不允许使用。",
        "settings.hooksCommandEnvCount": "env：{keys}",
        "settings.hooksTestGateCommandsHint": "每行一个命令。命令按顺序运行，在第一个失败处停止，这样子代理每次只收到一份错误摘要去修复。",
    },
}

ANCHOR = "settings.hooksCommandTestCwd"

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
