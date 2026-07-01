# The open question — research notes

> Why this project exists, what the hypothesis is, and how someone could actually test it.
> For the project overview see the [README](../README.md); for how the engine works see
> [architecture.md](architecture.md).

## The hypothesis

I built this because I have a **hypothesis** I can't stop thinking about: if music continuously
_fits the actual drive_ — its tempo, its phase, the traffic, the falling light — then the driving
_experience_, and maybe some measurable parts of driving _behaviour_ in specific situations,
might shift with it. Calmer in a jam; more engaged on a monotonous night highway. That's the
thing I want to find out.

Here's the honest evidence: This repo isn't proof of the hypothesis; it's the **system that makes the hypothesis testable**.

## Prior work

The question isn't new:

- **Brodsky (2001)** — music tempo affected simulated speed estimates, driving speed and virtual
  violations. [doi:10.1016/S1369-8478(01)00025-0](<https://doi.org/10.1016/S1369-8478(01)00025-0>)
- **Ünal et al. (2013)** — music, arousal and performance in a monotonous simulator task.
  [doi:10.1016/j.trf.2013.09.004](https://doi.org/10.1016/j.trf.2013.09.004)
- **Wen et al. (2019)** — in-vehicle music listening against workload, physiology and
  driving-performance indicators. [PMID 31382474](https://pubmed.ncbi.nlm.nih.gov/31382474/)
- **Meta-analysis (2024)** — pooled 19 studies on music, driving performance, and
  physiological/psychological indicators. [PMID 38235004](https://pubmed.ncbi.nlm.nih.gov/38235004/)

What I haven't seen is a system that couples the music to the **real drive in real time** —
telemetry read as signals over time — instead of to a static playlist, and that's open enough for
anyone to check.

## What makes this different

- **Telemetry as a time-series, not a label.** The engine reads pace, trends, ETA, region,
  traffic delay and journey phase as signals over time, then changes the musical brief when the
  drive changes.
- **Deterministic core, LLM at the edge.** Unit-tested heuristics decide the intent; the LLM only
  finds real, current tracks for that intent.
- **Situational moments.** Jam release, border crossing, golden hour, arrival and adaptive
  calm/focus modes bias the setlist without claiming to make the drive safer.
- **Open measurement surface.** The same system that picks the music can expose the signals
  needed for an opt-in experiment.

## How you could test this

The app **does not measure driving behaviour today** — Tesla access is read-only and nothing here
closes the loop between the music and how you drove. If you wanted to actually probe the
hypothesis, the ingredients are mostly already flowing through the engine; you'd log and
correlate them:

- **Dependent variables (driving side):** average and peak speed, acceleration variance
  (stop-and-go vs. smooth glide), how quickly pace recovers after a jam clears — all derivable
  from the telemetry the poller already reads.
- **Independent variables (music side):** the per-track energy/tempo the brief targets, the active
  drive-mode bias, and the moment events the engine fires (jam, jam-release, golden hour,
  arrival).
- **The experiment:** does the driving side move _with_ the music side, in the situations where
  the hypothesis predicts it should — and does a shuffled-playlist control group differ?

I'd genuinely like to see someone do this properly (ideally not n=1, ideally not just me). PRs
that add opt-in, privacy-respecting logging — or a critique of why the whole premise is shaky —
are welcome.

## A note on safety

To be explicit: this is **not a safety or driver-assistance system** and claims no proven effect
on behaviour or attention. Adaptive Drive Mode and journey moments bias song _selection_ only
(read-only Tesla access — no volume/DSP/BPM control). See
[Project status & limitations](../README.md#project-status--limitations) in the README.
