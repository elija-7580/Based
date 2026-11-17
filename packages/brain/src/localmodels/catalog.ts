// BSD-231 Teil 2a: Katalog der lokalen Modelle – feste Quellen (Hugging Face, auf einen Commit gepinnt), Größe und
// SHA-256 je Datei (aus der Hugging-Face-API: LFS-Prüfsumme bzw. selbst nachgerechnet, 13.11.2026). Nichts davon
// wird geladen, solange der Nutzer den Zweck nicht einschaltet (LocalModelManager). Laufzeit folgt (Teil 3:
// whisper.cpp als Tauri-Sidecar/auf dem based-server, ONNX im Worker).
import type { LocalModelSpec } from "./types.js";

const hf = (repo: string, commit: string, file: string) => `https://huggingface.co/${repo}/resolve/${commit}/${file}`;

const WHISPER = { repo: "ggerganov/whisper.cpp", commit: "5359861c739e955e79d9a303bcbc70fb988958b1" };
const E5 = { repo: "Xenova/multilingual-e5-small", commit: "761b726dd34fb83930e26aab4e9ac3899aa1fa78" };

export const LOCAL_MODEL_CATALOG: readonly LocalModelSpec[] = [
  {
    id: "whisper-base",
    purpose: "transcription",
    name: "Whisper base (multilingual, whisper.cpp)",
    version: "ggml-" + WHISPER.commit.slice(0, 7),
    license: "MIT (OpenAI Whisper weights, whisper.cpp)",
    files: [
      { path: "ggml-base.bin", url: hf(WHISPER.repo, WHISPER.commit, "ggml-base.bin"), size: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
    ],
  },
  // Elija 17.11.: drei Stufen zur Auswahl – Fast (base), Balanced (small, vorausgewählt), Best (large-v3-turbo).
  {
    id: "whisper-small",
    purpose: "transcription",
    name: "Whisper small (multilingual, whisper.cpp)",
    version: "ggml-" + WHISPER.commit.slice(0, 7),
    license: "MIT (OpenAI Whisper weights, whisper.cpp)",
    files: [
      { path: "ggml-small.bin", url: hf(WHISPER.repo, WHISPER.commit, "ggml-small.bin"), size: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" },
    ],
  },
  {
    id: "whisper-large-v3-turbo",
    purpose: "transcription",
    name: "Whisper large v3 turbo (multilingual, whisper.cpp)",
    version: "ggml-" + WHISPER.commit.slice(0, 7),
    license: "MIT (OpenAI Whisper weights, whisper.cpp)",
    files: [
      { path: "ggml-large-v3-turbo.bin", url: hf(WHISPER.repo, WHISPER.commit, "ggml-large-v3-turbo.bin"), size: 1_624_555_275, sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69" },
    ],
  },
  {
    id: "multilingual-e5-small",
    purpose: "embeddings",
    name: "multilingual-e5-small (ONNX, quantized)",
    version: E5.commit.slice(0, 7),
    license: "MIT (intfloat/multilingual-e5-small)",
    files: [
      { path: "onnx/model_quantized.onnx", url: hf(E5.repo, E5.commit, "onnx/model_quantized.onnx"), size: 118_308_185, sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193" },
      { path: "tokenizer.json", url: hf(E5.repo, E5.commit, "tokenizer.json"), size: 17_082_730, sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39" },
      { path: "config.json", url: hf(E5.repo, E5.commit, "config.json"), size: 658, sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1" },
      { path: "tokenizer_config.json", url: hf(E5.repo, E5.commit, "tokenizer_config.json"), size: 443, sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b" },
    ],
  },
];

/** Alle Katalogeinträge für einen Zweck, in Katalogreihenfolge (Transkription: klein → groß). */
export const catalogAll = (purpose: LocalModelSpec["purpose"]) => LOCAL_MODEL_CATALOG.filter((m) => m.purpose === purpose);

/** Elija 17.11.: vorausgewähltes Transkriptionsmodell (deutlich besser bei Deutsch als base, noch flott). */
export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-small";

/** Katalogeintrag für einen Zweck (der erste passende). */
export const catalogFor = (purpose: LocalModelSpec["purpose"]) => LOCAL_MODEL_CATALOG.find((m) => m.purpose === purpose);
