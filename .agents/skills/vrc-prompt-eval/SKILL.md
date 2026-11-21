---
name: vrc-prompt-eval
description: Evaluate and improve visual-reverse-compiler prompt quality using a 5-image benchmark, raw 3x3 crops and EXIF, image reconstruction, objective metrics, and sentence ablation. Use when tuning promptSpec.ts, testing reverse-prompting fidelity, or evaluating prompt-refinement changes.
---

# VRC Prompt Evaluation & Refinement

Prove and improve the reconstruction fidelity of `visual-reverse-compiler`'s 2-agent reverse-prompting workflow while keeping the 2-block output (`json_prompt` + lossless telegraphic `short_prompt`) unchanged.

## 1. Build a 5-Image Benchmark
Select 5 diverse test images in `test/eval-bench/` and record source/license in `test/eval-bench/manifest.json`:
1. Realistic close-up portrait (skin texture, directional light)
2. Product or still-life (material reflections, shadows)
3. Illustration / stylized art (brushwork, linework)
4. Graphic poster or UI with typography (text fidelity, layout)
5. Low-key night scene or 3D render (complex lighting, depth)

Include at least 1–2 images with known ground-truth prompts or EXIF metadata.
**Done when**: 5 images and `manifest.json` exist on disk.

## 2. Inspect Raw Materials
Run the local helper script on each benchmark image before compiling prompts:
```bash
python .agents/skills/vrc-prompt-eval/scripts/metrics.py slice <image_path> test/eval-bench/slices/<id>
```
- View each full-resolution image and its 3×3 crops (`read_file`), plus any EXIF focal length/aperture.
- Read `src/services/promptSpec.ts`, `src/utils/imagePhysics.ts`, and `src/services/visionCompiler.ts`.
**Done when**: Every image's raw crops, EXIF (if present), and current prompt/physics code are inspected.

## 3. Run Baseline (Subagents + Text-to-Image Generation)
For each of the 5 images, delegate in parallel via `invoke_subagent`:
1. **Reverse-compile**: Run Agent 1 (`VISUAL_DIVERGE_SYSTEM_PROMPT`) on the image + physics digest, then run Agent 2 (`SHORT_CONVERGE_SYSTEM_PROMPT`) on the Agent 1 JSON + `recommended_ar`, and pass the combined payload through `normalizeCompiledResult`; save raw diverge JSON, raw converge JSON, and normalized output.
2. **Reconstruct**: Generate at least 2 reconstructions per prompt (using serialized `json_prompt` text and lossless `short_prompt`) via the configured text-to-image model (or local `image-generator` fallback) to check stability and verify zero-loss compression.
3. **Swap subject**: Generate 2 subject-swapped images per image by replacing the subject description in `json_prompt.subject` / `short_prompt` cleanly—at least 1 cross-color and cross-category swap.
**Done when**: Baseline raw/normalized JSONs, >= 2 reconstructions per image, and 2 subject-swapped images per image are saved.

## 4. Score with Objective Evidence
Never rely on reading prompts alone; collect external evidence:
- **Quantitative similarity** (run on every original vs reconstruction pair, comparing both `json_prompt` and `short_prompt` reconstructions):
  ```bash
  python .agents/skills/vrc-prompt-eval/scripts/metrics.py compare <orig_path> <gen_path>
  ```
  Record `global_palette_delta_e`, `spatial_mean_delta_e`, `lum_delta`, `edge_structure_cosine`, and `lab_cosine_similarity`.
- **Independent QA audit (TIFA/DSG)**: Spawn an independent subagent (`Model: "flash"`) to split each `json_prompt` into binary yes/no visual questions, answer them blindly against both the original and generated images, and compute pass rate. Also verify verbatim text preservation between `json_prompt` and `short_prompt`.
- **Subject-swap check**: Inspect swapped images (`read_file`) to verify style/lighting/framing held, new subject appeared, and original subject did not bleed through.
**Done when**: All 5 images have metric JSONs, QA pass rates, and swap inspection notes.

## 5. Ablate & Diagnose
On the 2 lowest-scoring images, remove clauses from the prompt one by one and regenerate:
- Identify deadweight phrases (removal changes nothing) vs missing visual dimensions.
- Check whether `imagePhysics.ts` K-Means palette averaging distorted small high-saturation accents or biased camera/lens guesses.
**Done when**: Specific failure causes and ablation findings are documented for the weakest 2 images.

## 6. Iterate & Compare
Edit `src/services/promptSpec.ts` (and `src/utils/imagePhysics.ts` only if metrics prove color extraction is the bottleneck).
Re-run Steps 3–4 across all 5 images.
**Gate**: Keep changes only when aggregate objective metrics and QA pass rates improve without clear regression on any single image.
**Done when**: Improved prompt/code is verified across all 5 images.

## 7. Deliver
Present a before/after report containing:
- Metrics table (ΔE, luminance delta, edge/Lab similarity, QA pass rate)
- Side-by-side paths to original, baseline, and improved generated images
- Ablation conclusions and exact code/prompt changes made
