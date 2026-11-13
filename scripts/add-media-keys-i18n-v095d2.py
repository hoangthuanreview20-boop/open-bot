#!/usr/bin/env python3
"""Insert v0.95d2 media-keys i18n strings into all 6 locale files.

Keys are inserted right after "settings.modelPlaceholder" (kept in the
settings.* region); key order does not matter to the i18n tests, which
only require identical key sets across locales.
"""
import json
from collections import OrderedDict

NEW = {
    "vi": {
        "settings.mediaKeys.title": "Khóa media",
        "settings.mediaKeys.intro": "Khóa API của chính bạn để tạo ảnh và video. App không có sẵn model tạo ảnh/video — dán khóa của provider bạn muốn dùng. Khóa chỉ nằm trên máy này trong Vault và không bao giờ hiện đầy đủ.",
        "settings.mediaKeys.loading": "Đang tải khóa media…",
        "settings.mediaKeys.loadError": "Không tải được khóa media.",
        "settings.mediaKeys.saveError": "Không lưu được khóa media.",
        "settings.mediaKeys.save": "Lưu khóa",
        "settings.mediaKeys.clear": "Xóa khóa",
        "settings.mediaKeys.configured": "Đã lưu khóa (…{suffix})",
        "settings.mediaKeys.missing": "Chưa có khóa — chưa tạo được ảnh/video bằng provider này.",
        "settings.mediaKeys.kind.image": "Ảnh",
        "settings.mediaKeys.kind.video": "Video",
        "settings.mediaKeys.provider.stability": "Stability AI",
        "settings.mediaKeys.provider.replicate": "Replicate",
        "settings.mediaKeys.provider.runway": "Runway",
        "settings.mediaKeys.provider.luma": "Luma",
        "settings.mediaKeys.provider.pika": "Pika",
        "settings.mediaKeys.hint.openai": "Trang API keys của OpenAI (platform.openai.com) — cùng khóa này cũng dùng được cho chat.",
        "settings.mediaKeys.hint.gemini": "Trang API keys của Google AI Studio (aistudio.google.com) — cùng khóa này cũng dùng được cho chat.",
        "settings.mediaKeys.hint.stability": "Tài khoản Stability AI → API Keys (platform.stability.ai).",
        "settings.mediaKeys.hint.replicate": "Tài khoản Replicate → API tokens (replicate.com).",
        "settings.mediaKeys.hint.runway": "Tài khoản Runway → API keys (dev.runwayml.com).",
        "settings.mediaKeys.hint.luma": "Trang API keys của Luma Labs Dream Machine (lumalabs.ai).",
        "settings.mediaKeys.hint.pika": "Tài khoản Pika → API keys (pika.art).",
    },
    "en": {
        "settings.mediaKeys.title": "Media keys",
        "settings.mediaKeys.intro": "Your own API keys for image and video generation. The app has no built-in image or video model — paste the key of the provider you want to use. Keys stay on this machine in the Vault and are never shown in full.",
        "settings.mediaKeys.loading": "Loading media keys…",
        "settings.mediaKeys.loadError": "Could not load media keys.",
        "settings.mediaKeys.saveError": "Could not save the media key.",
        "settings.mediaKeys.save": "Save key",
        "settings.mediaKeys.clear": "Delete key",
        "settings.mediaKeys.configured": "Key saved (…{suffix})",
        "settings.mediaKeys.missing": "No key yet — image/video generation with this provider is off.",
        "settings.mediaKeys.kind.image": "Image",
        "settings.mediaKeys.kind.video": "Video",
        "settings.mediaKeys.provider.stability": "Stability AI",
        "settings.mediaKeys.provider.replicate": "Replicate",
        "settings.mediaKeys.provider.runway": "Runway",
        "settings.mediaKeys.provider.luma": "Luma",
        "settings.mediaKeys.provider.pika": "Pika",
        "settings.mediaKeys.hint.openai": "OpenAI API keys page (platform.openai.com) — the same key also works for chat.",
        "settings.mediaKeys.hint.gemini": "Google AI Studio API keys page (aistudio.google.com) — the same key also works for chat.",
        "settings.mediaKeys.hint.stability": "Stability AI account → API Keys (platform.stability.ai).",
        "settings.mediaKeys.hint.replicate": "Replicate account → API tokens (replicate.com).",
        "settings.mediaKeys.hint.runway": "Runway account → API keys (dev.runwayml.com).",
        "settings.mediaKeys.hint.luma": "Luma Labs Dream Machine API keys page (lumalabs.ai).",
        "settings.mediaKeys.hint.pika": "Pika account → API keys (pika.art).",
    },
    "zh": {
        "settings.mediaKeys.title": "媒体密钥",
        "settings.mediaKeys.intro": "用于生成图片和视频的你自己的 API 密钥。本应用没有内置的图片或视频模型——请粘贴你想使用的服务商密钥。密钥仅保存在本机的 Vault 中，永不完整显示。",
        "settings.mediaKeys.loading": "正在加载媒体密钥…",
        "settings.mediaKeys.loadError": "无法加载媒体密钥。",
        "settings.mediaKeys.saveError": "无法保存媒体密钥。",
        "settings.mediaKeys.save": "保存密钥",
        "settings.mediaKeys.clear": "删除密钥",
        "settings.mediaKeys.configured": "密钥已保存 (…{suffix})",
        "settings.mediaKeys.missing": "尚未设置密钥——无法使用此服务商生成图片/视频。",
        "settings.mediaKeys.kind.image": "图片",
        "settings.mediaKeys.kind.video": "视频",
        "settings.mediaKeys.provider.stability": "Stability AI",
        "settings.mediaKeys.provider.replicate": "Replicate",
        "settings.mediaKeys.provider.runway": "Runway",
        "settings.mediaKeys.provider.luma": "Luma",
        "settings.mediaKeys.provider.pika": "Pika",
        "settings.mediaKeys.hint.openai": "OpenAI 的 API keys 页面 (platform.openai.com)——同一密钥也可用于聊天。",
        "settings.mediaKeys.hint.gemini": "Google AI Studio 的 API keys 页面 (aistudio.google.com)——同一密钥也可用于聊天。",
        "settings.mediaKeys.hint.stability": "Stability AI 账户 → API Keys (platform.stability.ai)。",
        "settings.mediaKeys.hint.replicate": "Replicate 账户 → API tokens (replicate.com)。",
        "settings.mediaKeys.hint.runway": "Runway 账户 → API keys (dev.runwayml.com)。",
        "settings.mediaKeys.hint.luma": "Luma Labs Dream Machine 的 API keys 页面 (lumalabs.ai)。",
        "settings.mediaKeys.hint.pika": "Pika 账户 → API keys (pika.art)。",
    },
    "ja": {
        "settings.mediaKeys.title": "メディアキー",
        "settings.mediaKeys.intro": "画像・動画生成のためのあなた自身の API キーです。本アプリに画像・動画モデルは内蔵されていません——使いたいプロバイダーのキーを貼り付けてください。キーはこのマシンの Vault にのみ保存され、全文表示されることはありません。",
        "settings.mediaKeys.loading": "メディアキーを読み込み中…",
        "settings.mediaKeys.loadError": "メディアキーを読み込めませんでした。",
        "settings.mediaKeys.saveError": "メディアキーを保存できませんでした。",
        "settings.mediaKeys.save": "キーを保存",
        "settings.mediaKeys.clear": "キーを削除",
        "settings.mediaKeys.configured": "キーを保存済み (…{suffix})",
        "settings.mediaKeys.missing": "キー未設定——このプロバイダーでは画像/動画を生成できません。",
        "settings.mediaKeys.kind.image": "画像",
        "settings.mediaKeys.kind.video": "動画",
        "settings.mediaKeys.provider.stability": "Stability AI",
        "settings.mediaKeys.provider.replicate": "Replicate",
        "settings.mediaKeys.provider.runway": "Runway",
        "settings.mediaKeys.provider.luma": "Luma",
        "settings.mediaKeys.provider.pika": "Pika",
        "settings.mediaKeys.hint.openai": "OpenAI の API keys ページ (platform.openai.com)——同じキーはチャットにも使えます。",
        "settings.mediaKeys.hint.gemini": "Google AI Studio の API keys ページ (aistudio.google.com)——同じキーはチャットにも使えます。",
        "settings.mediaKeys.hint.stability": "Stability AI アカウント → API Keys (platform.stability.ai)。",
        "settings.mediaKeys.hint.replicate": "Replicate アカウント → API tokens (replicate.com)。",
        "settings.mediaKeys.hint.runway": "Runway アカウント → API keys (dev.runwayml.com)。",
        "settings.mediaKeys.hint.luma": "Luma Labs Dream Machine の API keys ページ (lumalabs.ai)。",
        "settings.mediaKeys.hint.pika": "Pika アカウント → API keys (pika.art)。",
    },
    "es": {
        "settings.mediaKeys.title": "Claves multimedia",
        "settings.mediaKeys.intro": "Tus propias claves API para generar imágenes y vídeos. La app no tiene un modelo integrado de imagen o vídeo: pega la clave del proveedor que quieras usar. Las claves quedan solo en esta máquina, en la Vault, y nunca se muestran completas.",
        "settings.mediaKeys.loading": "Cargando claves multimedia…",
        "settings.mediaKeys.loadError": "No se pudieron cargar las claves multimedia.",
        "settings.mediaKeys.saveError": "No se pudo guardar la clave multimedia.",
        "settings.mediaKeys.save": "Guardar clave",
        "settings.mediaKeys.clear": "Eliminar clave",
        "settings.mediaKeys.configured": "Clave guardada (…{suffix})",
        "settings.mediaKeys.missing": "Aún no hay clave: no se puede generar imagen/vídeo con este proveedor.",
        "settings.mediaKeys.kind.image": "Imagen",
        "settings.mediaKeys.kind.video": "Vídeo",
        "settings.mediaKeys.provider.stability": "Stability AI",
        "settings.mediaKeys.provider.replicate": "Replicate",
        "settings.mediaKeys.provider.runway": "Runway",
        "settings.mediaKeys.provider.luma": "Luma",
        "settings.mediaKeys.provider.pika": "Pika",
        "settings.mediaKeys.hint.openai": "Página de API keys de OpenAI (platform.openai.com); la misma clave también sirve para el chat.",
        "settings.mediaKeys.hint.gemini": "Página de API keys de Google AI Studio (aistudio.google.com); la misma clave también sirve para el chat.",
        "settings.mediaKeys.hint.stability": "Cuenta de Stability AI → API Keys (platform.stability.ai).",
        "settings.mediaKeys.hint.replicate": "Cuenta de Replicate → API tokens (replicate.com).",
        "settings.mediaKeys.hint.runway": "Cuenta de Runway → API keys (dev.runwayml.com).",
        "settings.mediaKeys.hint.luma": "Página de API keys de Luma Labs Dream Machine (lumalabs.ai).",
        "settings.mediaKeys.hint.pika": "Cuenta de Pika → API keys (pika.art).",
    },
    "fr": {
        "settings.mediaKeys.title": "Clés média",
        "settings.mediaKeys.intro": "Vos propres clés API pour générer des images et des vidéos. L’application n’a pas de modèle intégré d’image ou de vidéo : collez la clé du fournisseur que vous voulez utiliser. Les clés restent uniquement sur cette machine, dans le Vault, et ne sont jamais affichées en entier.",
        "settings.mediaKeys.loading": "Chargement des clés média…",
        "settings.mediaKeys.loadError": "Impossible de charger les clés média.",
        "settings.mediaKeys.saveError": "Impossible d’enregistrer la clé média.",
        "settings.mediaKeys.save": "Enregistrer la clé",
        "settings.mediaKeys.clear": "Supprimer la clé",
        "settings.mediaKeys.configured": "Clé enregistrée (…{suffix})",
        "settings.mediaKeys.missing": "Aucune clé pour l’instant : impossible de générer image/vidéo avec ce fournisseur.",
        "settings.mediaKeys.kind.image": "Image",
        "settings.mediaKeys.kind.video": "Vidéo",
        "settings.mediaKeys.provider.stability": "Stability AI",
        "settings.mediaKeys.provider.replicate": "Replicate",
        "settings.mediaKeys.provider.runway": "Runway",
        "settings.mediaKeys.provider.luma": "Luma",
        "settings.mediaKeys.provider.pika": "Pika",
        "settings.mediaKeys.hint.openai": "Page API keys d’OpenAI (platform.openai.com) — la même clé sert aussi pour le chat.",
        "settings.mediaKeys.hint.gemini": "Page API keys de Google AI Studio (aistudio.google.com) — la même clé sert aussi pour le chat.",
        "settings.mediaKeys.hint.stability": "Compte Stability AI → API Keys (platform.stability.ai).",
        "settings.mediaKeys.hint.replicate": "Compte Replicate → API tokens (replicate.com).",
        "settings.mediaKeys.hint.runway": "Compte Runway → API keys (dev.runwayml.com).",
        "settings.mediaKeys.hint.luma": "Page API keys de Luma Labs Dream Machine (lumalabs.ai).",
        "settings.mediaKeys.hint.pika": "Compte Pika → API keys (pika.art).",
    },
}

ANCHOR = "settings.modelPlaceholder"

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
