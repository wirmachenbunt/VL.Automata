# VL.Automata — developer notes & decisions

Context for anyone (human or AI) picking this up later. The **README.md** covers
*usage*; this file covers *why it's built the way it is* and the vvvv-specific
gotchas we discovered the hard way, so we don't re-derive them.

Port of the cables op `Ops.Local.Automata`
(`../StandaloneVersion/ops/Ops.Local.Automata/`) to a vvvv gamma C# library.
The cables op has two halves that map directly:
- engine (`Ops.Local.Automata.js`) → `Engine/AutomataEngine.cs` + `Engine/AutomataData.cs`
- Konva canvas editor (`att_inc_editor.js`) → `Editor/AutomataEditorWidget.cs`

## The single most important finding (don't re-litigate)

**A referenced C# project in vvvv gamma only gets type-import — its
`AssemblyInitializer` / `RegisterNodeFactory` never runs.** We verified this
directly (a factory-registered probe never appeared; a `[ProcessNode]` probe did),
including after full gamma restarts, with and without `[ImportAsIs]`.

Consequences:
- The **node factory** approach (`IVLNodeDescriptionFactory` + `NodeBuilding`,
  which is the *only* way to get one dynamic **bang pin per transition** like the
  cables op) requires the library to be **deployed as a package** in the packs
  folder (the way VL.ImGui itself is loaded). It does NOT work as a project ref.
- So the node is a **`[ProcessNode]`** (`Nodes/AutomataNode.cs`), which vvvv *does*
  import from a referenced project via `[assembly: ImportAsIs]`
  (`Properties/AssemblyInfo.cs`). ProcessNode pins are fixed, so per-transition /
  per-region data is exposed as **spreads / a selector**, not individual pins.

If we ever want true individual per-transition bang pins: bring back the factory
(it's in git history — `AutomataNodeFactory.cs` + `Initialization.cs`, it compiled
fine) and **package + deploy to packs**, don't reference the project.

## Node pin design (chosen with the user)

Firing a transition went through several iterations; the user settled on
**bang + selector**:
- `Fire` (bool/bang) + `Transition` (string id or "A to B" title) → on Fire's
  rising edge, fire the named transition.
- Rejected: `Spread<bool>` aligned to transition index (awkward to bang);
  `Spread<string>` of ids (can't "bang" a string).

Outputs include `Transition Ids` / `Transition Titles` (so the user can pick a
value for `Transition`), plus region activity as aligned `Region Active` /
`Region Ids` spreads. `Editor` is a **Skia `ILayer`** (see below). Full pin table
in README.

## Build setup

- **`net8.0-windows`** + **`<EnableWindowsTargeting>true</EnableWindowsTargeting>`** —
  required because `VL.ImGui.Skia` / `VL.Skia` are windows-only; EnableWindowsTargeting
  lets it **build on macOS** too (pulls the Windows targeting packs). Confirmed working.
- Package versions must match the local gamma install; currently
  **`2025.7.3-0015-g49df5281c9`**. The exact `-NNNN-g…` builds live on the vvvv
  TeamCity feed (see `NuGet.config`), NOT nuget.org (which only has base `2025.7.x`).
  A version mismatch falls back with an NU1603 warning — harmless for building; the
  built DLL is plain IL and loads fine in gamma regardless.
- `[assembly: ImportAsIs]` is required for the `[ProcessNode]` to be imported.

## Rendering the editor (ILayer / ToSkiaLayer / DIPTopLeft)

- The node wraps the ImGui editor widget with **`VL.ImGui.ToSkiaLayer`** in C# and
  outputs a **`VL.Skia.ILayer`** on the `Editor` pin, so the patch wires it straight
  into a renderer — no `ToSkiaLayer` node needed.
  `_toSkia.Update(widget, dockingEnabled:false, fonts:Spread<FontConfig>.Empty, fullscreenWindow:false, Style:null)`.
- **The renderer's `Space` MUST be `DIPTopLeft`.** Its default space is
  centered/normalized, which renders ImGui at ~half scale in the bottom-right
  quarter. This cost us a debugging session — see the diagnostics we removed.
- The editor widget pins its ImGui window to fill the canvas: `SetNextWindowPos(Vector2.Zero)`
  + `SetNextWindowSize(io.DisplaySize)` with no decorations. Use `(0,0)` (canvas
  top-left), NOT `GetMainViewport().Pos` (that's an OS-desktop offset for a
  Skia-rendered ImGui).

## Editor implementation (ImGui via VL.ImGui)

- Custom drawing goes through **`VL.ImGui.Widgets.ImmediateModeWidget`** with
  `Updator = Action<VL.ImGui.Context>`. `VL.ImGui.Widget.UpdateCore` is
  `internal abstract`, so you **cannot** subclass Widget externally — ImmediateModeWidget
  is the sanctioned raw-ImGui hook.
- **Namespace gotcha:** inside `namespace VL.Automata`, the bare name `ImGui`
  resolves to the sibling namespace `VL.ImGui`, shadowing `ImGuiNET.ImGui`. We alias
  `using IG = ImGuiNET.ImGui;` and call `IG.*`. Also `ImGuiInputTextFlags` exists in
  both namespaces → aliased to the ImGuiNET one.
- Everything is stored in **document coordinates** and mapped through a pan/zoom
  transform (`ToScreen`/`ToDoc`, `_pan`, `_zoom`). Radii/fonts scale with zoom; hit
  tolerances are divided by zoom to stay constant in screen pixels; state-drag delta
  is `MouseDelta / _zoom`.
- Interactions match the cables editor exactly (see README list). Notably:
  **right-drag = pan** (distinguished from right-click-a-state = start-transition via
  the drag threshold, `IsMouseDragging`); Ctrl+click = force state / run transition
  (drives the engine via `ForceState`/`ForceTransition` hooks); Alt/Middle = delete.
- **START state**: `AutomataNode.EnsureStart` creates one for an empty machine; the
  editor's `RemoveState` refuses to delete a START-labelled state or the last state.
- Colors are the cables palette (`#2f2f2f` fill, `#0e1113` stroke, `#f6a21a` active
  highlight — only the active state is orange, `#eaf7ff` labels, `#28e5ff`/`#ffd166`
  transitions, `rgba(64,180,255,…)` regions). State radius `AutomataEngine.StateRadius`
  (currently 96). Soft drop shadow faked with stacked translucent circles (ImGui has
  no blur).
- The editor edits the shared `AutomataDocument` in place; on change it calls
  `Changed`, which the node wires to "reload engine + save the `.automata` file".

## Local verification loop (no Windows needed for most of it)

- **Engine** is dependency-free and unit-tested: `scratchpad/enginetest` (27 parity
  checks vs the cables logic). Run with `dotnet run` (retarget to net10 if only the
  net10 runtime is installed).
- **Factory/editor/node** compile-check against the real vvvv API on macOS — the real
  `VL.Automata.csproj` builds locally thanks to EnableWindowsTargeting. (Earlier we
  used a `scratchpad/factorycheck` net8.0 project referencing just VL.Core + VL.ImGui.)
- To inspect vvvv API surface we couldn't find in docs, we used **reflection** —
  `Assembly.Load` for net8.0 assemblies, and **`MetadataLoadContext`** (package
  `System.Reflection.MetadataLoadContext`) for the windows-only VL.Skia /
  VL.ImGui.Skia (guarding against unresolved WinForms refs). This is how we found
  `ToSkiaLayer.Update`, `ImmediateModeWidget.Updator`, `NodeBuilding` signatures, etc.
- On-screen behaviour (does the node appear, does the editor render) can only be
  checked in the user's gamma — that's the one thing we can't do from here.

## Reference material on disk

- `reference/Packs/VL.ImGui/` and `reference/Packs/VL.ImGui.Skia/` — the actual packs
  (read-only), incl. `lib/net8.0*/…` assemblies + XML docs and `help/*.vl` examples
  (esp. `help/Advanced/HowTo Build A Custom Editor.vl`, `help/Primitives/HowTo Draw a *`).
- `reference/demonodeproject/` — the `[ProcessNode]` + `[ImportAsIs]` template that
  established the working import pattern.

## Open / possible future work

- Individual per-transition bang pins → requires the factory + packaging (above).
- Editor niceties not yet ported: fit-to-content / reset-view key; wiring
  `Reset Target` to a dropdown of the `States` output.
- Default spacing for newly created states could grow with the larger radius so they
  don't overlap.
