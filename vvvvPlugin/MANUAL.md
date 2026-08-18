# VL.Automata — User Manual

A **finite-state-machine** node for **vvvv gamma**. You draw a state machine in a built-in visual
editor, and the node runs it: it reports the current state, counts frames, tracks "regions", and
lets you trigger transitions from your patch. It's a port of the cables op `Ops.Local.Automata`.

This manual is for *using* the node. For how it's built and why, see [DEVNOTES.md](DEVNOTES.md).

---

## Contents

1. [Concepts](#1-concepts)
2. [Quick start](#2-quick-start)
3. [The editor](#3-the-editor)
4. [Running the machine](#4-running-the-machine)
5. [Pin reference](#5-pin-reference)
6. [Saving your machine (the Data pin)](#6-saving-your-machine-the-data-pin)
7. [Performance & display options](#7-performance--display-options)
8. [Tips & troubleshooting](#8-tips--troubleshooting)

---

## 1. Concepts

- **State** — a named situation the machine can be in (e.g. `Idle`, `Run`, `Jump`). Exactly **one
  state is active** at a time.
- **Transition** — a one-way connection from one state to another (`Idle → Run`). You **fire** it
  to move the machine along that edge. A transition has a **frame delay**: how many patch frames it
  takes to complete (0 = instant).
- **START** — every machine has a state labelled `START`. It's where the machine begins and the
  default reset target. It can't be deleted.
- **Region** — a circular zone you draw on the canvas. Whenever the **active state's circle sits
  inside a region**, that region reports **active (1)**, otherwise **0**. Regions are a handy way to
  ask "is the machine somewhere in this group of states?" without wiring every state.
- **Frame** — the machine advances **one step per patch frame**. So "frames" is a real frame count
  at your patch's frame rate.

---

## 2. Quick start

1. **Drop the `Automata` node.**
2. **Wire `Editor` → a Skia renderer / RenderWindow.** `Editor` is already a Skia layer; connect it
   straight in. **No renderer setting is needed** — the editor places itself top-left at 1:1 and
   takes mouse input correctly even in the renderer's default *Normalized* space.
3. **Author the machine** in the renderer window (see [The editor](#4-the-editor)): add a couple of
   states, connect them with transitions.
4. **Run it.** The machine steps every frame on its own. To move it along an edge, **bang the
   matching pin** under the `Fire` pin group.
5. **Read the outputs** — `Active State`, `State Frames`, `Transition Countdown`, `Region Active`,
   etc. — and drive the rest of your patch from them.

Your machine is **saved inside the patch** automatically. There's no external file.

---

## 3. The editor

The editor is the window you get by wiring `Editor` into a renderer. Everything is drawn on a
pannable, zoomable canvas.

### Navigating

| Action | Result |
|--------|--------|
| **right-drag** empty canvas | pan the view |
| **mouse wheel** | zoom (around the cursor) |

Pan/zoom are per-session view settings; they are **not** saved into the machine.

### Building the machine

**States**

| Action | Result |
|--------|--------|
| **double-click** empty canvas | add a state |
| **drag** a state | move it |
| **double-click** a state | rename it (inline) |
| **Alt-click** or **Middle-click** a state | delete it (and its transitions) |

**Transitions**

| Action | Result |
|--------|--------|
| **right-click** a state, then **left-click** another state | create a transition between them |
| **double-click** a transition | edit its **frame delay** |
| **Alt-click** or **Middle-click** a transition | delete it |

**Regions**

| Action | Result |
|--------|--------|
| **Alt-drag** empty canvas | create a region (drag out its radius) |
| **drag** a region body | move it |
| **drag** a region's edge | resize it |
| **double-click** a region | rename it (inline) |
| **Alt-click** or **Middle-click** a region | delete it |

**Driving the machine by hand** (useful while authoring)

| Action | Result |
|--------|--------|
| **Ctrl-click** a state | force the machine into that state now |
| **Ctrl-click** a transition | run that transition now (jumps to its *from* state, then starts it) |

### What you see

- The **active state** is highlighted with a **cyan ring**, live from the running machine.
- A **transition in progress** (a multi-frame delay counting down) is highlighted **amber**.
- Transitions are labelled **`A to B [Nf]`** — the from/to states and the frame delay `N`.
- The **START** state always exists and can't be deleted; the machine also refuses to delete the
  last remaining state.

Every edit takes effect **immediately** and is saved with the patch. The running machine keeps its
active state across edits wherever that state still exists.

---

## 4. Running the machine

The machine advances **one step per patch frame** automatically — you don't need to clock it.

### Firing a transition

The **`Fire`** pin group has **one bang pin per transition**, named by the transition's title (e.g.
`Idle to Run`). These pins appear, disappear, and rename **automatically** as you edit transitions.

- **Bang** the pin for the transition you want. On the bang's **rising edge** the transition fires.
- A transition only fires when it is **valid**: its *from* state is the **current** active state,
  **and** no other transition is already in progress. Otherwise the bang is ignored.
- The `Transition Titles` output lists the same titles, so you can match pin names in your patch.

### Frame delays (multi-frame transitions)

A transition's **frame delay** `N` is how many frames it takes to complete:

- **`N = 0`** — the transition is **instant**: the active state changes on the same frame.
- **`N > 0`** — firing starts a **pending** transition:
  - `Next State` shows the target,
  - `Transition Countdown` runs from **1 → 0** over the `N` frames,
  - `State Frames` is **frozen** (it only counts time settled in a state, not time spent moving),
  - after `N` frames the machine arrives in the target state and `State Frames` restarts at 0.

While a transition is pending, **no other transition can fire** until it completes.

### Resetting

- **`Reset`** (bool): a **rising edge** resets the machine.
- **`Reset Target`** (string): the **state label** to reset to. Leave it **empty to reset to
  START**. (If the label isn't found, it falls back to START / the first state.) A reset cancels any
  pending transition.

### Reading the machine

| Output | Meaning |
|--------|---------|
| `Active State` | label of the current state |
| `Next State` | target of a pending transition (empty when none) |
| `State Frames` | frames spent settled in the current state (frozen during a transition) |
| `Transition Countdown` | pending transition progress, **1 → 0** (0 when none) |
| `States` | all state labels — handy to drive a `Reset Target` dropdown |
| `Transition Titles` | all `A to B` titles — these match the `Fire` pin names |
| `Region Active` | `1`/`0` per region, aligned with `Region Names` |
| `Region Names` | each region's name (its title, or its id if unnamed) |

`Region Active` and `Region Names` are **aligned spreads** — index *i* in one matches index *i* in
the other. A region reads **1** whenever the active state's circle lies within that region.

---

## 5. Pin reference

| Direction | Pin | Type | Meaning |
|-----------|-----|------|---------|
| in | `Data` | string | The machine as JSON, **stored in the patch**. Leave it **unconnected** — the node reads and writes it. You can paste JSON in to load a machine, or copy it out. See [§7](#7-saving-your-machine-the-data-pin). |
| in | `Reset Target` | string | State label to reset to. Empty = **START**. |
| in | `Reset` | bool | **Rising edge** resets the machine. |
| in | `No UI Mode` | bool | When **true**, skip drawing the editor and output a null `Editor` — the machine, outputs and `Fire` pins keep working. Use it in a running/exported patch to save the per-frame editor cost. Default **false** = UI on. |
| in | `No Background` | bool | **Inspector-only** (hidden on the node face; edit it in the Inspektor). When **true** the editor canvas is transparent, so the renderer shows through. Default **false** = opaque. |
| in | `Fire` | pin group of bool (bang) | **One pin per transition**, named by its `A to B` title. Rising edge fires that transition (if valid). Auto-synced to the machine. |
| out | `Active State` | string | Current state label. |
| out | `Next State` | string | Target of a pending transition. |
| out | `State Frames` | int | Frames spent in the current state. |
| out | `Transition Countdown` | float | Pending transition progress, 1 → 0. |
| out | `States` | Spread\<string> | All state labels (reset targets). |
| out | `Transition Titles` | Spread\<string> | All `A to B` titles (match the `Fire` pin names). |
| out | `Region Active` | Spread\<float> | 1/0 per region, aligned with `Region Names`. |
| out | `Region Names` | Spread\<string> | Region names. |
| out | `Editor` | ILayer (Skia) | The editor as a Skia layer — wire straight into a renderer. |

---

## 6. Saving your machine (the `Data` pin)

Your machine lives on the **`Data`** input pin as JSON and is **saved inside the `.vl` patch** —
there is no external file.

- **Leave `Data` unconnected.** The node reads it to load the machine and writes it back on every
  edit, so the machine travels with the patch (this is the gamma equivalent of beta's "save to a
  hidden pin").
- Because it's a real pin, you can **copy the JSON out** of one node, or **paste a machine in** to
  load it. Pasting an external machine loads it and keeps your current pan/zoom.
- A freshly dropped node stores a `START`-only machine automatically.

> The active-state position is *not* re-saved every frame during playback — only your edits are
> persisted — so autosave stays cheap.

---

## 7. Performance & display options

- **`No UI Mode`** — the editor's per-frame drawing is the node's biggest cost. In a finished or
  exported patch where you don't need to see or edit the machine, set `No UI Mode = true`: the
  editor stops drawing (and `Editor` outputs null), while the machine, outputs and `Fire` pins keep
  running. Toggle it back off and the editor resumes instantly with your view intact.
- **`No Background`** (Inspektor-only) — set it true to make the editor canvas transparent, so
  whatever the renderer draws behind it shows through. Useful for overlaying the editor on other
  visuals.

---

## 8. Tips & troubleshooting

- **My `Fire` bang did nothing.** A transition only fires when its *from* state is the current
  active state and nothing else is transitioning. Check `Active State`, and that no
  `Transition Countdown` is in progress.
- **The `Fire` pin I wired disappeared.** `Fire` pins are named by transition **title**. Renaming a
  state (and thus the `A to B` title) or deleting the transition changes/removes the pin. Match pins
  by the `Transition Titles` output if you rewire dynamically.
- **The editor shows in the wrong place / input is offset.** You don't need to change the renderer's
  Space — the node handles it. If you previously set the renderer to `DIPTopLeft` by hand, that's no
  longer necessary.
- **I want to reset somewhere other than START.** Feed the target **state label** into
  `Reset Target` (drive it from the `States` output for a valid list), then pulse `Reset`.
- **Instant vs. gradual transitions.** Set a transition's frame delay to `0` for an immediate jump,
  or a higher number to make it take that many frames (watch `Transition Countdown`).
- **Load an existing machine.** Paste its JSON into the `Data` pin. Copy a machine out the same way.
