# VL.Automata — vvvv gamma port of the cables Automata op

A finite-state-machine node for vvvv gamma, ported from the cables op
`Ops.Local.Automata`. The state machine is authored in an ImGui editor **window**
(not a docked tab); the running node reports the active state, frame counters and
region activity, and fires transitions.

## Layout

```
VL.Automata/
  VL.Automata.csproj        net8.0, refs VL.Core + VL.ImGui (ImGui.NET transitively)
  Properties/AssemblyInfo.cs [assembly: ImportAsIs]  (so vvvv imports the node)
  Engine/AutomataData.cs    JSON data model (states/transitions/regions)
  Engine/AutomataEngine.cs  pure state-machine core (port of the cables engine)
  Nodes/AutomataNode.cs     the [ProcessNode] exposed in gamma
  Editor/AutomataEditorWidget.cs  ImGui DrawList editor (VL.ImGui.Widget)
reference/Packs/            VL.ImGui + VL.ImGui.Skia packs (read-only, API lookup)
reference/demonodeproject/  the [ProcessNode] template that established the pattern
Demo.automata              sample document
```

## Node model

Implemented as a `[ProcessNode]` (category `Automata`). The low-level node factory
that would give one bang pin *per transition* only runs when the library is
deployed as a vvvv **package** in the packs folder; as a **referenced project**
(the dev setup here) vvvv imports `[ProcessNode]` classes, so the per-transition /
per-region parts are exposed as **aligned spreads** instead of individual pins.

`Automata` pins:

| direction | pin | type | meaning |
|-----------|-----|------|---------|
| in | `Path` | string | path to a `.automata` file (same JSON as the cables op) |
| in | `Advance` | bool | step the machine one frame while true |
| in | `Reset Target` | string | state label to reset to (empty = START) |
| in | `Reset` | bool | rising edge resets |
| in | `Fire` | bool (bang) | rising edge fires the transition named by `Transition` |
| in | `Transition` | string | id or title of the transition to fire (see Transition Titles) |
| out | `Active State` | string | current state label |
| out | `Next State` | string | target of a pending (multi-frame) transition |
| out | `State Frames` | int | frames spent in the current state |
| out | `Transition Countdown` | float | pending transition progress, 1 → 0 |
| out | `States` | Spread&lt;string&gt; | reset-target labels |
| out | `Transition Ids` | Spread&lt;string&gt; | transition ids — **align `Fire` to this** |
| out | `Transition Titles` | Spread&lt;string&gt; | "A to B" labels (display) |
| out | `Region Active` | Spread&lt;float&gt; | 1/0 per region, aligned with Region Ids |
| out | `Region Ids` | Spread&lt;string&gt; | region ids |
| out | `Editor` | ILayer (Skia) | the editor as a Skia layer — wire straight into a renderer |

**Firing a transition:** set `Transition` to a transition's **id** or **title**
(from the `Transition Ids` / `Transition Titles` outputs) and bang `Fire`. On Fire's
rising edge that transition fires — only when it's valid from the current state with
nothing pending. To drive different transitions from different events, switch
`Transition` per event and bang `Fire`.

## Editor window

`Editor` is already a Skia **`ILayer`** — the node wraps the ImGui widget with
`VL.ImGui.ToSkiaLayer` internally, so you don't need a `ToSkiaLayer` node. Wire it
straight into a renderer:

```
Automata.Editor  →  Skia renderer / RenderWindow
```

**Renderer setting:** set the renderer's **Space** to **`DIPTopLeft`** so ImGui
renders 1:1 from the top-left. (The renderer's default space is centered/normalized,
which puts the editor in a corner at half scale.)

Editing the graph mutates the document live: the engine reloads (keeping the
active state valid) and the `.automata` file is saved. Interactions:

- **double-click empty canvas** → add a state
- **drag a state** → move it
- **double-click a state** → rename it (inline)
- **right-click a state, then left-click another** → create a transition
- **double-click a transition** → edit its frame delay
- **Ctrl + click a state** → force the machine into that state
- **Ctrl + click a transition** → run it now (jumps to its `from`, then starts it)
- **Alt/Middle + click** a state / transition / region → delete it
- **Alt + drag** empty canvas → create a region (drag out the radius)
- **drag a region body** → move it; **drag its edge** → resize it
- **right-drag** → pan the canvas;  **mouse wheel** → zoom (around the cursor)

A **START** state always exists (created for an empty machine) and can't be deleted.
Transitions are labelled `A to B [Nf]`. The active state (cyan ring) and any
in-progress transition (amber) are highlighted live from the running engine.

## Dev loop (local gamma)

1. `dotnet build -c Release` → `bin/Release/net8.0/VL.Automata.dll`.
2. In gamma, add a dependency on the built `VL.Automata.dll` (or reference the
   `.csproj`).
3. Drop the **Automata** node (category `Automata`).
4. Set `Path` to a `.automata` file (copy `Demo.automata`), wire the `Editor`
   layer straight into a renderer / RenderWindow to open the editor window.
5. Toggle `Advance` to run; pulse a `Fire` slot to change state; watch
   `Active State` / `State Frames` / `Transition Countdown` / `Region Active`.

Note: `[ProcessNode]` classes hot-reload on rebuild; the node factory path does not
(it needs a full package + gamma restart), which is why this port uses ProcessNode.

## Status

- Engine: ported and unit-tested (27 parity checks against the cables logic).
- `[ProcessNode]` + editor: confirmed working in gamma (referenced project); the
  editor renders via ILayer into a renderer (Space = DIPTopLeft).
- Full editor interactions (states, transitions, regions, rename, frames, delete)
  implemented — pending on-screen verification against the cables editor.
