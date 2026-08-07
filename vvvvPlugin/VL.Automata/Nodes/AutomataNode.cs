using VL.Automata.Engine;
using VL.ImGui;
using VL.Lang.PublicAPI;
using VL.Lib.Collections;
using VL.Model;
using VL.Skia;
// 'using VL.ImGui' pulls in VL.ImGui.PinAttribute, which collides with the import
// attribute we need here — alias to the VL.Core.Import one (same gotcha as the editor).
using Pin = VL.Core.Import.PinAttribute;

namespace VL.Automata;

// The Automata FSM node for vvvv gamma — the [ProcessNode] port of the cables op
// Ops.Local.Automata.
//
// Firing a transition: the 'Fire' input is a *dynamic pin group* — the node keeps
// one bang pin per transition in sync with the machine (named by the transition's
// "A to B" title). Bang the pin for the transition you want; on its rising edge that
// transition fires, but only when it's valid from the current state with nothing
// pending. The pins are added/removed automatically as you edit the machine, via the
// vvvv solution API (ISolution.ModifyPinGroup) — see SyncFirePins. This works from a
// referenced project (no packaging/factory needed): the pin group is a compile-time
// [Pin(PinGroupKind=…)] attribute the [ImportAsIs] importer reads, and the sync is
// pure edit-time solution editing through IDevSession.Current.
//
// 'Data' is the machine itself, stored as JSON on an input pin — this is the
// persistence. The node reads it to load the machine, and on every edit writes the
// serialized document back into the pin via the solution API (ISolution.SetPinValue),
// so the machine is saved *inside the .vl patch*, not in an external file (this is the
// gamma equivalent of beta's "save data to a hidden pin"; VL.Audio.VST persists a VST
// plugin's state chunk the same way). 'Editor' is the editor as a Skia ILayer; wire it
// straight into a renderer — SetSpaceUpstream2 forces DIPTopLeft space so it renders
// (and takes input) correctly in the renderer's default Normalized Space, no setting to
// change. Editing updates the engine and the Data pin.
[ProcessNode(Name = "Automata", Category = "Automata")]
public class AutomataNode : IDisposable
{
    // The input pin (string, JSON) that stores the machine *in the patch*. Must match the
    // pin name vvvv derives from the 'data' parameter of Update — that's the pin
    // SetPinValue addresses by name.
    private const string DataPinName = "Data";

    // Persist the machine into the pin's value in the .vl document, but don't recompile
    // (~AffectCompilation) or add an undo step (~AddToHistory): continuous autosave that
    // doesn't disturb the running graph. Same update kind VL.Audio.VST uses for its state.
    // NOTE: the write *does* echo back into the live 'data' pin next frame — LoadIfChanged
    // guards against that (via _persistedData) so our own autosave doesn't rebuild the editor.
    private const SolutionUpdateKind JustWriteToThePin =
        SolutionUpdateKind.Default & ~SolutionUpdateKind.AffectCompilation & ~SolutionUpdateKind.AddToHistory;

    // The node's own context — needed to address this node application when editing its
    // Fire pin group and its Data pin value (Path.Stack.Peek() is this node's UniqueId).
    // vvvv injects it into the constructor of an imported node rather than as a pin.
    private readonly NodeContext _nc;

    private readonly AutomataEngine _engine = new();
    // Wraps the ImGui editor widget as a Skia layer, so the node can output an
    // ILayer directly — no ToSkiaLayer node needed in the patch. Held per instance
    // because it owns the Skia render state.
    private readonly ToSkiaLayer _toSkia = new();
    // Forces the editor layer into DIPTopLeft space, so it renders 1:1 from the
    // top-left in the renderer's *default* Normalized space — the user needn't change
    // the renderer's Space. This is VL.Skia's own space-setting layer (the C# node
    // behind "SetSpace"): unlike a render-only wrapper, its Notify path also re-derives
    // the mouse PositionInWorldSpace for the new space (ToSkiaLayer reads that, not the
    // caller transform), so visuals *and* input line up. Wraps _toSkia once; _toSkia
    // is still updated every frame to refresh the ImGui draw data.
    private readonly SetSpaceUpstream2 _editorSpace = new();
    private readonly ILayer _editorLayer;
    private AutomataEditorWidget? _editor;
    // The machine JSON as last seen on the 'Data' input pin. Reload the editor/engine
    // only when the pin value actually changes (sentinel so the first Update loads).
    private string _loadedData = "\0";
    // Last JSON written into the 'Data' pin — skip redundant writes (and the resulting
    // document-dirty) when the serialized document hasn't changed.
    private string _persistedData = "\0";
    private bool _docDirty;
    private bool _prevReset;

    // Fire pin-group bookkeeping. The pin name shown in the patch is the transition
    // title (made unique); these maps translate a pin back to its transition id and
    // track each pin's previous value for rising-edge detection.
    private readonly Dictionary<string, string> _firePinToTransitionId = new();
    private readonly Dictionary<string, bool> _prevFirePins = new();
    // Engine version last synced to the Fire pin group; the pin group is only re-synced
    // (a document edit) when the engine reloads, never every frame. -1 forces a first sync.
    private int _firePinsVersion = -1;

    // Cached output spreads. Everything derived purely from the document (state labels,
    // transition titles, region names) is rebuilt only when the engine version changes;
    // region activity also when the active state moves. A steadily-running node (no edit,
    // no transition settling) then allocates nothing here per frame.
    private int _cachedVersion = -1;
    private string? _regionActiveStateId;
    private Spread<string> _statesCache = Spread<string>.Empty;
    private Spread<string> _transitionTitlesCache = Spread<string>.Empty;
    private Spread<string> _regionNamesCache = Spread<string>.Empty;
    private Spread<float> _regionActiveCache = Spread<float>.Empty;

    public AutomataNode(NodeContext nodeContext)
    {
        _nc = nodeContext;
        // Wrap _toSkia so the output layer is always in DIPTopLeft space. The wrapper
        // recomputes its transform from the caller each frame, so this one call is enough.
        _editorSpace.Update(_toSkia, out _editorLayer, CommonSpace.DIPTopLeft);
    }

    public void Update(
        // The machine as JSON, stored on this pin and saved with the patch (see class doc
        // and PersistData). Leave it unconnected — the node reads and writes it. You can
        // still paste a machine's JSON in to load it, or copy it out.
        string? data,
        string? resetTarget,
        bool reset,
        // Headless switch: when true, skip the ImGui frame + ToSkiaLayer update entirely and
        // output a null Editor layer. The engine still steps, outputs still update and the
        // Fire pins still drive transitions — you just don't build/draw the editor UI. Leave
        // the Editor pin unconnected in a running/exported patch and flip this on to reclaim
        // the per-frame editor cost (the single biggest one in the node). Default false =
        // UI on = the node behaves exactly as before.
        bool noUIMode,
        // Must be the *concrete* Dictionary<string, object> — VL's dictionary-pin-group
        // codegen only recognises that exact shape; an IReadOnlyDictionary<> (or a bool
        // value type) drops to a path that emits an untyped Spread and the patch fails to
        // compile (CS0411 on CollectionBuilders.GetBuilder). Value type is object because
        // the concrete pin type (bool) is set per pin via builder.Add in SyncFirePins.
        // This mirrors VL.Audio.VST's EffectHost.parameters exactly.
        [Pin(PinGroupKind = PinGroupKind.Dictionary, PinGroupEditMode = PinGroupEditModes.RemoveOnly)]
        Dictionary<string, object> fire,
        out string activeState,
        out string nextState,
        out int stateFrames,
        out float transitionCountdown,
        out Spread<string> states,
        out Spread<string> transitionTitles,
        out Spread<float> regionActive,
        out Spread<string> regionNames,
        out ILayer? editor)
    {
        LoadIfChanged(data ?? "");

        // Apply editor edits: reload the engine (keeps the active state valid) and
        // persist the document back into the Data pin so it survives reload / save.
        if (_docDirty && _editor is not null)
        {
            _engine.Load(_editor.Document);
            PersistData(_editor.Document.Serialize());
            _docDirty = false;
        }

        var transitions = _engine.TransitionPins;

        // Keep one bang pin per transition. Only touches the document when the
        // transition set changed (SyncFirePins is a no-op otherwise).
        SyncFirePins(transitions);

        // Fire a transition on the rising edge of its pin. Valid-from-current-state /
        // nothing-pending is enforced by the engine.
        if (fire is not null)
        {
            foreach (var (pin, raw) in fire)
            {
                var value = raw is bool b && b; // pins are bool; unbox defensively
                var prev = _prevFirePins.TryGetValue(pin, out var p) && p;
                if (value && !prev && _firePinToTransitionId.TryGetValue(pin, out var tid))
                    _engine.FireTransition(tid);
                _prevFirePins[pin] = value;
            }
        }

        // vvvv evaluates the node every patch frame, so step the machine every frame —
        // that's what makes State Frames count and timed transitions progress. No gate:
        // there's no trigger line in vvvv, the node just runs.
        _engine.StepFrame();

        if (reset && !_prevReset) _engine.Reset(resetTarget);
        _prevReset = reset;

        activeState = _engine.ActiveState;
        nextState = _engine.NextState;
        stateFrames = _engine.StateFrames;
        transitionCountdown = (float)_engine.TransitionCountdown;

        // Rebuild the document-derived output spreads only when the machine reloaded.
        bool versionChanged = _engine.Version != _cachedVersion;
        if (versionChanged)
        {
            _cachedVersion = _engine.Version;
            _statesCache = _engine.States.ToSpread();
            _transitionTitlesCache = transitions.Select(t => t.Title).ToSpread();
            _regionNamesCache = _engine.RegionPins.Select(r => r.Name).ToSpread();
        }

        // Region activity also depends on the active state (which moves as transitions
        // settle); recompute when the reload changed the region set OR the active state moved.
        var activeId = _engine.ActiveStateId;
        if (versionChanged || activeId != _regionActiveStateId)
        {
            _regionActiveStateId = activeId;
            _regionActiveCache = _engine.RegionPins.Select(r => _engine.RegionActive(r.Id)).ToSpread();
        }

        states = _statesCache;
        transitionTitles = _transitionTitlesCache;
        regionActive = _regionActiveCache;
        regionNames = _regionNamesCache;

        // Wrap the ImGui widget into a Skia layer for direct output. _toSkia.Update
        // refreshes the ImGui draw data; the output is _editorLayer (_toSkia wrapped in
        // SetSpaceUpstream2), which forces DIPTopLeft space so it renders — and takes
        // input — correctly in the renderer's default Normalized space.
        //
        // No-UI mode skips this whole block: _toSkia.Update is what runs the full ImGui
        // frame (our Draw pass + all hit-testing) each frame, so gating it is the actual
        // saving — the widget object stays alive but idle (Draw only runs from here), so
        // flipping noUIMode back off resumes instantly with pan/zoom intact.
        if (_editor is null || noUIMode)
        {
            editor = null;
        }
        else
        {
            _toSkia.Update(_editor.Widget, dockingEnabled: false, fonts: Spread<FontConfig>.Empty, fullscreenWindow: false, Style: null);
            editor = _editorLayer;
        }
    }

    // Load the machine from the Data pin into the engine + editor, but only when the pin
    // value is one we don't already have (or on first run). A fresh/empty pin yields a
    // START-only machine, which is persisted back so a newly dropped node saves a valid
    // document. Rebuilding replaces the editor widget (and its view state) — see the guard
    // and the pan/zoom carry-over below for why that must not happen on our own autosave.
    private void LoadIfChanged(string data)
    {
        // Skip when the pin value is something we already have — either what we last loaded
        // (_loadedData) OR what we just autosaved (_persistedData). Our SetPinValue write
        // echoes back into the live 'data' pin next frame; without the _persistedData check
        // that echo would rebuild the editor on every edit, snapping pan/zoom back to
        // default. Only a genuinely *external* value (e.g. a pasted machine) rebuilds.
        if (_editor is not null && (data == _loadedData || data == _persistedData)) return;
        _loadedData = data;

        var doc = AutomataDocument.Parse(data);
        EnsureStart(doc);
        _engine.Load(doc);

        // View state (pan/zoom) isn't in the document; carry it across the rebuild so an
        // external load doesn't snap the view to default.
        var prevPan = _editor?.Pan ?? default;
        var prevZoom = _editor?.Zoom ?? 1f;

        _editor?.Dispose();
        _editor = new AutomataEditorWidget("Automata", doc)
        {
            Changed = () => _docDirty = true,
            ActiveStateId = () => _engine.ActiveStateId,
            PendingTransitionId = () => _engine.PendingTransitionId,
            ForceState = id => _engine.ForceState(id),
            ForceTransition = id => _engine.ForceTransition(id),
            Pan = prevPan,
            Zoom = prevZoom
        };
        _prevFirePins.Clear();
        _prevReset = false;

        // The pin currently holds 'data'; only write if EnsureStart/normalisation changed
        // it (e.g. a fresh empty node gains a START state). Avoids dirtying on open.
        _persistedData = data;
        var canonical = doc.Serialize();
        if (canonical != data) PersistData(canonical);
    }

    // Write the machine JSON into the Data pin's value in the .vl document, so the machine
    // is saved with the patch. Skips redundant writes; a no-op outside an editing session
    // (IDevSession.Current is null in an exported app, where the value is already baked in).
    private void PersistData(string json)
    {
        if (json == _persistedData) return;
        _persistedData = json;

        var solution = IDevSession.Current?.CurrentSolution;
        if (solution is null) return;

        solution.SetPinValue(_nc.Path.Stack.Peek(), DataPinName, json).Confirm(JustWriteToThePin);
    }

    // Add/remove Fire pins so there is exactly one per transition, named by its title
    // (deduplicated). Runs only when the transition set changed, and only in an editing
    // session (IDevSession.Current is null in an exported/standalone app, where the pins
    // are already baked into the document). ModifyPinGroup's builder synchronises the
    // group to exactly the pins we Add — transitions removed from the machine drop their
    // pins automatically.
    private void SyncFirePins(IReadOnlyList<AutomataEngine.TransitionPin> transitions)
    {
        // The transition set (and each title, derived from state labels) only changes when
        // the engine reloads. Skip on every other frame — no per-frame allocation/scan.
        if (_engine.Version == _firePinsVersion) return;

        var solution = IDevSession.Current?.CurrentSolution;
        if (solution is null) return; // exported app / no editor — retry when a session exists

        var nodeId = _nc.Path.Stack.Peek();
        var boolType = _nc.AppHost.TypeRegistry.GetTypeInfo(typeof(bool)).Name;
        var builder = solution.ModifyPinGroup(nodeId, "Fire", isInput: true);

        _firePinToTransitionId.Clear();
        var used = new HashSet<string>();
        foreach (var t in transitions)
        {
            var name = UniquePinName(t.Title, used);
            builder.Add(name, boolType);
            _firePinToTransitionId[name] = t.Id;
        }
        // TweakLast keeps this out of a separate undo step / avoids a full recompile.
        builder.Commit().Confirm(SolutionUpdateKind.TweakLast);

        // Only mark synced after a successful commit — if there was no session above we
        // returned early without updating this, so the sync retries once one exists.
        _firePinsVersion = _engine.Version;
    }

    // Pin names must be unique within the group; two transitions can share a title
    // (e.g. duplicate "A to B"), so disambiguate collisions with a numeric suffix.
    private static string UniquePinName(string title, HashSet<string> used)
    {
        var baseName = string.IsNullOrWhiteSpace(title) ? "Transition" : title;
        var name = baseName;
        for (var i = 2; !used.Add(name); i++) name = $"{baseName} ({i})";
        return name;
    }

    // A state machine always has a START state; create one for an empty document
    // (deletion of START is prevented in the editor).
    private static void EnsureStart(AutomataDocument doc)
    {
        if (doc.States.Count == 0)
            doc.States.Add(new StateData { Id = "s-" + Guid.NewGuid().ToString("N")[..8], Label = "START", X = 200, Y = 200 });
    }

    public void Dispose()
    {
        _editor?.Dispose();
        _toSkia.Dispose();
    }
}
