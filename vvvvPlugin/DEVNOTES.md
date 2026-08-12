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

We originally concluded from this that **per-transition bang pins require the node
factory, hence packaging**. **That conclusion is now superseded** — see the next
section. The factory finding still stands *for factories*; we just don't need one.

## Dynamic per-transition pins WITHOUT a factory (the current design)

We get one bang pin per transition on the plain `[ProcessNode]`, no packaging, via
the vvvv **solution-editing API** — the same mechanism VL.Audio.VST's `EffectHost`
uses for its per-parameter pins (`syncPinGroup`). Two independent pieces make it work,
neither of which is the factory:

1. **A pin group declared as a method-parameter attribute.** `Update` takes
   `[Pin(PinGroupKind = PinGroupKind.Dictionary, PinGroupEditMode = PinGroupEditModes.None)]
   IReadOnlyDictionary<string,bool> fire`. `PinGroupKind`/`PinGroupEditModes` are in
   `VL.Model`; `PinAttribute` is `VL.Core.Import.PinAttribute` — the *same* namespace
   as `[ProcessNode]`/`[ImportAsIs]`, i.e. it's meant for imported nodes. A Dictionary
   pin group renders as N named pins; each pin's name is a dictionary key, its value the
   pin value.
2. **Editing our own pin group at edit time** via `IDevSession.Current.CurrentSolution`
   → `solution.ModifyPinGroup(nodeId, "Fire", isInput:true)` → `builder.Add(pinName,
   boolTypeName)` for every transition → `builder.Commit().Confirm(TweakLast)`. The
   builder *synchronises* the group to exactly the pins we Add, so removed transitions
   drop their pins. `nodeId` = `_nc.Path.Stack.Peek()` (this node's `UniqueId`);
   `NodeContext` is injected into the ProcessNode **constructor** (vvvv doesn't turn it
   into a pin). Type name via `_nc.AppHost.TypeRegistry.GetTypeInfo(typeof(bool)).Name`.
   See `AutomataNode.SyncFirePins`.

**All of these types live in `VL.Core.dll`** (namespaces `VL.Lang.PublicAPI`,
`VL.Model`, `VL.Core.Import`) — the package we already reference. No `VL.Lang`
reference, no packaging, no factory. Reflected the exact signatures out of
`VL.Core.dll` / `VL.Core.xml`; the canonical example patch is corelib's
`help/API/Patch/HowTo Create Pins Programmatically.vl`.

Sync discipline (important — `ModifyPinGroup`/`Confirm` **edit the document**):
- Only sync when the transition set actually changed (`_firePinsSignature`), never
  per frame.
- Only in an editing session — `IDevSession.Current` is null in an exported/standalone
  app, where the pins are already baked into the `.vl`. Guard on it.
- `Confirm(SolutionUpdateKind.TweakLast)` keeps it out of undo history / avoids a full
  recompile. It does not retrigger our load/edit paths, so no feedback loop.

**CONFIRMED WORKING IN GAMMA** (2025.7.3-0015): `[ImportAsIs]` honours the
`[Pin(PinGroupKind=…)]` param on the `[ProcessNode]`, `NodeContext` is injected into
the ProcessNode constructor, and the per-transition pins appear/update live — all from
a referenced project, no packaging, no factory. (If it had failed, the fallback was
the factory + packaging from git history: `AutomataNodeFactory.cs` + `Initialization.cs`.)

**One codegen gotcha we hit:** the pin-group param MUST be the *concrete*
`Dictionary<string, object>` (value type `object`, not `bool`; not `IReadOnlyDictionary<>`).
Anything else made the *patch's* generated code fail to compile with
`CS0411 … CollectionBuilders.GetBuilder<TValue>(Spread<TValue>, int) cannot be inferred`
— i.e. an EmitException at patch-compile time, before the node ever runs. The concrete
`Dictionary<string, object>` is exactly what VL.Audio.VST uses; the real bool pin type
is set per pin via `builder.Add(name, boolType)`, so the pins are still bool bangs. We
unbox with `raw is bool b && b`.

## Node pin design

Firing a transition went through several iterations: `Spread<bool>` aligned to index
(awkward to bang) and `Spread<string>` of ids (can't "bang" a string) were rejected;
then a **bang + `Transition` selector** stopgap (while we believed per-transition pins
needed packaging); now the **`Fire` dictionary pin group** above — one real bang pin
per transition, named by title, auto-synced. The selector pins are gone.

Outputs include `Transition Titles` (they match the `Fire` pin names), plus region
activity as aligned `Region Active` / `Region Names` spreads.
`Editor` is a **Skia `ILayer`** (see below). Full pin table in README.

## Per-frame allocation discipline (`AutomataEngine.Version`)

`Update` runs every patch frame, so anything it re-derives there is per-frame GC garbage
in the render loop. The rule: **derive from the document only when the document changed.**
The engine exposes a monotonic `Version` bumped in `Load` (the only place the
states/transitions/regions sets are rebuilt); active-state changes deliberately do *not*
bump it. The node caches against it:
- **Output spreads** (`states`, `transitionTitles`, `regionNames`) rebuild only when
  `Version` moves; `regionActive` also when `ActiveStateId` moves (it depends on both the
  region set and where the machine currently is). Spreads are immutable, so a steady node
  returns the cached instances and allocates nothing.
- **`SyncFirePins`** gates on `Version` instead of rebuilding an id+title signature string
  every frame — a rename/add/remove goes through `_engine.Load` (via `_docDirty`), which
  bumps `Version`, so it still catches title changes. It only marks itself synced *after* a
  successful commit, so the first sync still retries until `IDevSession.Current` exists.

Don't reintroduce per-frame LINQ/`ToSpread`/`string.Join` in `Update`; route new
document-derived outputs through the same `Version` (or `ActiveStateId`) cache checks.

## Persistence: the machine is stored *in the patch* (`Data` pin), not a file

We dropped the original external-`.automata`-file approach (`Path` pin + `File.Read/Write`).
The machine now lives on a **`Data` string input pin** as JSON and is saved inside the
`.vl` — the gamma equivalent of vvvv beta's "save data to a hidden pin". Same mechanism as
the `Fire` pins (solution editing via `IDevSession.Current.CurrentSolution`), and the same
technique VL.Audio.VST's `EffectHost` uses to persist a VST plugin's **state chunk** with
the patch (see `reference/vst/EffectHost.cs`: `StateInputPinName`, `SaveToPin`,
`SetPinValue`, its `JustWriteToThePin` update kind).

Mechanism (`AutomataNode.PersistData`):
```csharp
solution.SetPinValue(nodeId, "Data", json)
        .Confirm(SolutionUpdateKind.Default & ~AffectCompilation & ~AddToHistory);
```
- `SetPinValue(UniqueId nodeId, string pinName, object value)` writes the pin's **constant
  value** in the document (`nodeId = _nc.Path.Stack.Peek()`, same id as the pin-group edit).
  The pin name **must match** what vvvv derives from the `data` parameter → `"Data"`.
- **`~AffectCompilation`** persists into the document but does **not** recompile the
  running graph → continuous autosave on every edit is cheap (no recompile hitch).
- **`~AddToHistory`** keeps autosave out of undo.

**The write DOES echo back** (learned the hard way): after `SetPinValue`, the live `data`
pin reflects the new JSON on the *next* frame. So autosave feeds back into the read path.
Without a guard, that echo makes `LoadIfChanged` think the pin changed and **rebuild the
editor widget on every edit** — which resets pan/zoom to default (the widget instance holds
the view transform). (An earlier revision of these notes wrongly claimed `~AffectCompilation`
suppresses the echo; it does not.)

Sync discipline (mirrors the `Fire` pins):
- `LoadIfChanged` rebuilds editor+engine only when the incoming `data` is a value we don't
  already have — i.e. **`data != _loadedData && data != _persistedData`** (sentinel `"\0"`
  → first Update loads). The `_persistedData` half is what swallows our own autosave echo;
  only a *genuinely external* value (a pasted machine) rebuilds. That's the copy/paste-in
  feature.
- Rebuilding replaces the widget, so **pan/zoom are carried across** (`AutomataEditorWidget.
  Pan`/`Zoom`) — an external paste doesn't snap the view to default either. View state is
  session-transient, deliberately *not* stored in the document (persisting it would rewrite
  the pin on every pan/zoom).
- `PersistData` skips writes when the JSON equals `_persistedData` — avoids re-writing and,
  importantly, avoids **marking the document dirty on open** (EffectHost guards the same way
  with `if (!Equals(channel.Value, value))`). On load we prime `_persistedData = data`, then
  only write back if `EnsureStart`/normalisation changed it (a fresh empty node → `START`).
- No editing session (exported/standalone app): `IDevSession.Current` is null → `PersistData`
  is a no-op; the value is already baked into the exported document.

Note EffectHost keeps an `IChannel<T>` for the *live* value; we don't need that — the editor
widget holds the live document in memory, the pin is purely persistence.

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
- **The layer forces its own `DIPTopLeft` space — the renderer needs no setting.**
  We wrap `_toSkia` in VL.Skia's **`SetSpaceUpstream2`** (the C# node behind the "SetSpace"
  patch node, in `VL.Core.Skia/Transform.cs`, namespace `VL.Skia`): `_editorSpace.Update(
  _toSkia, out _editorLayer, CommonSpace.DIPTopLeft)`. So the editor renders 1:1 top-left
  even in the renderer's *default* `Normalized` Space.
  - **Don't hand-roll a render-only wrapper — input won't follow.** We first wrapped
    `_toSkia` in our own layer that only overrode `caller.Transformation` on `Render`.
    Visuals moved to the top-left correctly, but **mouse interaction was inverted-offset**
    (you had to click the bottom-right quarter to hit a top-left element). Reason:
    `ToSkiaLayer.Notify` **ignores `caller`** — it feeds ImGui
    `mouseNotification.PositionInWorldSpace.FromHectoToImGui()` (see
    `VL.ImGui/src/Helper/RenderHelper.cs`), and `PositionInWorldSpace` was already computed
    by the renderer in **Normalized** space. Fixing render alone leaves input in the old
    space. `SetSpaceUpstream2.Notify` handles this: it re-wraps the notification's *sender*
    (`IntermediateTransformNotificationSender`) with the **inverse** of the DIPTopLeft
    matrix, so `PositionInWorldSpace` is re-derived from the raw pixel `Position` for the
    new space. That sender type is `internal`, which is the other reason to use the library
    layer rather than reimplement it.
  - Why any of this is needed: `ToSkiaLayer.Render` draws ImGui through the **incoming**
    `caller.Transformation`, but always sizes ImGui in raw viewport **pixels**
    (`io.DisplaySize = ViewportBounds`). So it only lines up when `caller.Transformation`
    is the DIPTopLeft matrix. In the default Normalized space (origin centered, height =
    2 units) ImGui is drawn through a centered/half-scale matrix → bottom-right quarter.
    This used to require setting the renderer's Space to `DIPTopLeft` by hand.
  - The DIPTopLeft matrix (what `SetSpaceUpstream2` applies) = uniform scale `Scaling·100`
    (one unit = 100 DIP), origin at `ViewportBounds` top-left — see
    `VL.Core.Skia/CallerInfoExtensions.cs` (`GetWithinCommonSpaceTransformation`, `internal`)
    + `Enums.cs` (`CommonSpace`). `SetSpaceUpstream2` recomputes it from the caller every
    frame, so one `Update` call at construction is enough.
- **`No UI Mode` (headless switch).** `_toSkia.Update` is what runs the full ImGui frame
  each tick — `NewFrame` → our `Draw` (every `DrawList` call + all hit-testing) → draw-data
  gen — and it runs *even when the `Editor` pin is unconnected*, since `Update` runs every
  frame regardless. That's the single biggest per-frame cost, so the `noUIMode` input gates
  exactly that block: when true it skips `_toSkia.Update` and outputs a null `Editor`. The
  engine still steps and the `Fire`/output pins still work — you just lose the UI. The editor
  *widget* stays allocated but idle (`Draw` only runs from `_toSkia.Update`), so toggling the
  pin back off resumes instantly with pan/zoom intact. Default false = UI on = unchanged
  behaviour. Pin label "No UI Mode" is vvvv's acronym-aware split of the `noUIMode` param.
- **`No Background` (inspector-only, transparent canvas).** `[Pin(Visibility =
  PinVisibility.Optional)]` on the `noBackground` param makes it an *Inspektor-only* pin —
  hidden on the node face, editable in the pin inspector (`PinVisibility` lives in `VL.Model`,
  already imported; `Optional` = "user can configure the node to show this pin", i.e. the
  vvvv hidden-pin idiom — `Hidden` would hide it from the inspector too). Wired to the editor
  widget's `ShowBackground`. Transparency needs **both** halves dropped: the explicit
  `dl.AddRectFilled` canvas fill *and* `ImGuiWindowFlags.NoBackground` (else ImGui paints its
  own `WindowBg` under the skipped fill). Default false = opaque = unchanged.
- The editor widget pins its ImGui window to fill the canvas: `SetNextWindowPos(Vector2.Zero)`
  + `SetNextWindowSize(io.DisplaySize)` with no decorations. Use `(0,0)` (canvas
  top-left), NOT `GetMainViewport().Pos` (that's an OS-desktop offset for a
  Skia-rendered ImGui).

## DPI / UI scaling (typography-vs-geometry proportion)

- **Symptom.** On a machine with different Windows display scaling, the editor's
  proportions drift: circles look bigger relative to the labels, and the type looks a
  little softer. It is *not* the monitor resolution — it's the **UI scaling %** (the DPI
  factor), which usually differs from the dev box.
- **Cause.** Two coordinate worlds that VL.ImGui scales differently:
  - **Geometry** (`StateRadius = 96`, label paddings, gaps, line widths) are plain
    document units drawn as `const * _zoom`. No DPI factor.
  - **Type** goes through `IG.GetFontSize()`. VL.ImGui bakes the default font at
    `FontConfig.Size` (`0.16` hecto = **16 DIP**) × `ImGuiConversion.ToImGuiScaling`
    (`= DIPFactor * 100`), so **`GetFontSize()` == 16 · DIP** — it carries the host DPI.
  - `ToSkiaLayer.Render` then scales the whole frame by `FromImGuiScaling = 1/(DIP*100)`,
    which cancels the DIP out of the type but **not** out of the geometry. In-canvas the
    ratio is `circle : type = 96 : 16·DIP = 6/DIP` → lower-DPI box ⇒ relatively bigger
    circles. (So the machine that looked "right" is simply the higher-DPI one.)
  - The *softness* is separate: the font atlas is baked at the host DIP, so a lower-DPI
    box bakes fewer texels and upscales more at zoom. The fix below doesn't worsen it; a
    crisper atlas would mean baking the font larger (a `FontConfig` with a bigger `Size`).
- **Fix, part 1 — size type in document units (`AutomataEditorWidget.LabelFontSize`).**
  Instead of drawing at `IG.GetFontSize()` (which carries the host DIP), draw/measure the
  canvas labels at a constant **`LabelFontSize` in document units** — the same space as
  `StateRadius = 96`. The type-to-graphics proportion is then fixed by those two constants
  alone and is identical on every monitor; DIP never enters. `Text()` draws at
  `LabelFontSize * _zoom`; `TextSizeDoc()`/`TextSize()` rescale `CalcTextSize` (measured at
  the atlas bake size) by `FontDocScale = LabelFontSize / GetFontSize()`. The transition-label
  **hit-test** uses the same `TextSizeDoc` (so the pick box matches the drawn pill), and the
  inline-edit `editScale = FontDocScale * _zoom`. Geometry, hit-tests and the document are
  untouched — only the type is re-based, so interaction stays pixel-accurate. Tune
  `LabelFontSize` for label size.
- **Fix, part 2 — bake the atlas big (`AutomataNode.FontBakeSize`, `EditorFonts`).** The font
  atlas is a fixed raster; when the canvas is zoomed in ImGui magnifies the glyphs past their
  baked size → soft/pixelated type. We pass a custom `FontConfig` (the system UI face at
  `FontBakeSize = 0.8` hecto = 80 DIP × host DIP, vs the display size ~28) as the `fonts`
  spread to `_toSkia.Update`, so the glyphs stay crisp across the whole zoom range. Rule of
  thumb: **keep `FontBakeSize * 100 >= LabelFontSize * MaxZoom`** (here 80 ≥ 28·4 = 112 → bump
  bake or lower zoom if you raise the label size much). Being the only/first font makes it the
  default, so `IG.GetFontSize()` == the bake size (which `FontDocScale` divides back out).
  `FontConfig.Default` is null off-Windows → `EditorFonts` falls back to empty and VL.ImGui
  bakes its own default.
- **Help HUD is the exception.** `DrawHelp` is a fixed-size legend, not canvas content, and its
  default `AddText` would now render at the *big bake size*. It draws at an explicit
  `15 * DipFactor` px — a constant *physical* size (via VL.ImGui's own DIP source,
  `ImGuiConversion.ToImGuiScaling / 100`, `public` in the already-imported `VL.ImGui`) — so it
  neither zooms nor changes with DPI or bake size.

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
- `reference/vst/EffectHost.cs` — VL.Audio.VST's node (downloaded), the reference for
  the dynamic-pin-group technique. Look at `Update` (the `[Pin(PinGroupKind=…)]`
  param), `SyncPinGroup`, `AddToPinGroup`, `GetPinGroupBuilder`.
- corelib `help/API/Patch/HowTo Create Pins Programmatically.vl` — the canonical
  patch-side example of `ModifyPinGroup` / `PinGroupBuilder` (in the nuget cache).

## Packaging / distribution (planned — not done yet)

Publish as a NuGet to **nuget.org** (that's the feed vvvv's package manager reads;
`nuget.info` is only a package *inspector*, not a host). The project is already
`IsPackable` with a generated doc file and references the **public** VL.\* versions
(`2025.7.4`), so `dotnet pack -c Release` produces a working package today — no factory or
special layout needed, because `[assembly: ImportAsIs]` makes vvvv surface the
`[ProcessNode]` straight from `lib/net8.0-windows/`.

Before publishing:
- Add package metadata to the csproj: `PackageId` (`VL.Automata`), `Version`, `Authors`,
  `Description`, `PackageTags` (`vl vvvv …` — the `vl`/`vvvv` tags drive discoverability),
  license, `RepositoryUrl`, `PackageReadmeFile`.
- Keep the VL.\* dependency versions on **public nuget.org** builds (plain `2025.7.x`), never
  a TeamCity `-NNNN-g…` build — consumers can't restore those.
- Publish with `dotnet nuget push … --source https://api.nuget.org/v3/index.json` (needs an
  API key); users install via `nuget install VL.Automata` in the gamma commandline.

**Must run on both x64 and ARM (ARM64 Windows).** Our own assembly is **AnyCPU / pure IL**,
so it's already architecture-neutral — keep it that way: **no `PlatformTarget`, no
`RuntimeIdentifier`/RID pinning, no native code of our own** (we have none). `EnableWindowsTargeting`
doesn't constrain the architecture. Cross-arch then hinges entirely on the **native
dependencies** — SkiaSharp + cimgui, pulled transitively via `VL.Skia` / `VL.ImGui.Skia` —
shipping `win-arm64` natives alongside `win-x64`. Action item at pack time: confirm those
packages carry arm64 runtimes (check their `runtimes/win-arm64/native/…`), and smoke-test the
node on an ARM64 gamma. If a native dep lacks arm64, that's the blocker to chase, not our DLL.

## Open / possible future work

- **Verify the `Fire` pin group in gamma** (the two unverifiable-from-macOS points
  above). If ImportAsIs doesn't honour the pin-group param, fall back to factory +
  packaging driving the same group.
- Editor niceties not yet ported: fit-to-content / reset-view key; wiring
  `Reset Target` to a dropdown of the `States` output.
- Default spacing for newly created states could grow with the larger radius so they
  don't overlap.
