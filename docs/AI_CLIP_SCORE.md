# AI Clip Score

AnimaCut’s pre-publication score estimates the quality and short-form potential of a candidate. It is not a probability or a promise that the clip will go viral.

The semantic model returns component scores and explanations only. Application code computes:

```text
raw_score =
  hook_strength * 0.25
  + payoff_value * 0.20
  + standalone_clarity * 0.15
  + emotion_novelty * 0.15
  + shareability * 0.10
  + pacing * 0.10
  + technical_quality * 0.05

final_score = clamp(round(raw_score - penalties), 0, 97)
```

Pacing combines semantic pacing (60%), transcript/FFmpeg silence quality (25%), and speech onset (15%). FFmpeg records loudness, clipping, black frames, frozen frames, blur, resolution, frame rate, and scene boundaries. Scene-cut frequency is stored for segmentation but never earns virality points by itself.

Severe structural penalties are explicit:

- Starts mid-sentence or lacks required context: -8
- Ends before the payoff or mid-sentence: -10
- More than 1.5 seconds of non-meaningful opening silence: -5
- More than 25% dead air: -5
- Major black or frozen section: -8
- Transcript confidence too low to judge reliably: -5

Labels are Weak (0–59), Needs Work (60–69), Good (70–79), Strong (80–89), Excellent (90–94), and Exceptional (95–97). Values 98–100 remain reserved for future scores calibrated against real post-publication performance.
