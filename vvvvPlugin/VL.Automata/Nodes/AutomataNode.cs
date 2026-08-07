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
// 'Path' points at a .automata file (same JSON as the cables op). 'Editor' is the
// editor as a Skia ILayer; wire it straight into a renderer — it forces itself into
// DIPTopLeft space (TopLeftSpaceLayer), so it renders correctly in the renderer's
// default Normalized Space with no setting to change. Editing reloads the engine and
// saves the file.
[ProcessNode(Name = "Automata", Category = "Automata")]
public class AutomataNode : IDisposable
{
    // The node's own context — needed to address this node application when editing
    // its pin group (Path.Stack.Peek() is this node's UniqueId). vvvv injects it into
    // the constructor of an imported node rather than exposing it as a pin.
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
    private string _loadedPath = "\0"; // sentinel so first Update always loads
    private bool _docDirty;
    private bool _prevReset;

    // Fire pin-group bookkeeping. The pin name shown in the patch is the transition
    // title (made unique); these maps translate a pin back to its transition id and
    // track each pin's previous value for rising-edge detection.
    private readonly Dictionary<string, string> _firePinToTransitionId = new();
    private readonly Dictionary<string, bool> _prevFirePins = new();
    // Signature of the current transition set; the pin group is only re-synced (a
    // document edit) when this actually changes, never every frame.
    private string _firePinsSignature = "\0";

    public AutomataNode(NodeContext nodeContext)
    {
        _nc = nodeContext;
        // Wrap _toSkia so the output layer is always in DIPTopLeft space. The wrapper
        // recomputes its transform from the caller each frame, so this one call is enough.
        _editorSpace.Update(_toSkia, out _editorLayer, CommonSpace.DIPTopLeft);
    }

    public void Update(
        string? path,
        bool advance,
        string? resetTarget,
        bool reset,
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
        out Spread<string> transitionIds,
        out Spread<string> transitionTitles,
        out Spread<float> regionActive,
        out Spread<string> regionIds,
        out ILayer? editor)
    {
        EnsureLoaded(path ?? "");

        // Apply editor edits: reload the engine (keeps the active state valid) and
        // persist the document back to the file so it survives reload.
        if (_docDirty && _editor is not null)
        {
            _engine.Load(_editor.Document);
            SaveSafe(_loadedPath, _editor.Document);
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

        if (advance) _engine.StepFrame();

        if (reset && !_prevReset) _engine.Reset(resetTarget);
        _prevReset = reset;

        var regions = _engine.RegionPins;

        activeState = _engine.ActiveState;
        nextState = _engine.NextState;
        stateFrames = _engine.StateFrames;
        transitionCountdown = (float)_engine.TransitionCountdown;
        states = _engine.States.ToSpread();
        transitionIds = transitions.Select(t => t.Id).ToSpread();
        transitionTitles = transitions.Select(t => t.Title).ToSpread();
        regionActive = regions.Select(r => _engine.RegionActive(r.Id)).ToSpread();
        regionIds = regions.Select(r => r.Id).ToSpread();

        // Wrap the ImGui widget into a Skia layer for direct output. _toSkia.Update
        // refreshes the ImGui draw data; the output is _editorLayer (_toSkia wrapped in
        // SetSpaceUpstream2), which forces DIPTopLeft space so it renders — and takes
        // input — correctly in the renderer's default Normalized space.
        if (_editor is null)
        {
            editor = null;
        }
        else
        {
            _toSkia.Update(_editor.Widget, dockingEnabled: false, fonts: Spread<FontConfig>.Empty, fullscreenWindow: false, Style: null);
            editor = _editorLayer;
        }
    }

    private void EnsureLoaded(string path)
    {
        if (path == _loadedPath && _editor is not null) return;
        _loadedPath = path;

        var doc = AutomataDocument.Parse(ReadSafe(path));
        EnsureStart(doc);
        _engine.Load(doc);

        _editor?.Dispose();
        _editor = new AutomataEditorWidget(string.IsNullOrEmpty(path) ? "Automata" : path, doc)
        {
            Changed = () => _docDirty = true,
            ActiveStateId = () => _engine.ActiveStateId,
            PendingTransitionId = () => _engine.PendingTransitionId,
            ForceState = id => _engine.ForceState(id),
            ForceTransition = id => _engine.ForceTransition(id)
        };
        _prevFirePins.Clear();
        _prevReset = false;
    }

    // Add/remove Fire pins so there is exactly one per transition, named by its title
    // (deduplicated). Runs only when the transition set changed, and only in an editing
    // session (IDevSession.Current is null in an exported/standalone app, where the pins
    // are already baked into the document). ModifyPinGroup's builder synchronises the
    // group to exactly the pins we Add — transitions removed from the machine drop their
    // pins automatically.
    private void SyncFirePins(IReadOnlyList<AutomataEngine.TransitionPin> transitions)
    {
        // Cheap change-detection: id+title of every transition. Skip if unchanged.
        var sig = string.Join("\n", transitions.Select(t => t.Id + "\t" + t.Title));
        if (sig == _firePinsSignature) return;

        var solution = IDevSession.Current?.CurrentSolution;
        if (solution is null) return; // exported app / no editor — nothing to sync

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

        _firePinsSignature = sig;
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

    private static string ReadSafe(string path)
    {
        try { return !string.IsNullOrEmpty(path) && File.Exists(path) ? File.ReadAllText(path) : ""; }
        catch (IOException) { return ""; }
    }

    private static void SaveSafe(string path, AutomataDocument doc)
    {
        if (string.IsNullOrEmpty(path)) return;
        try { File.WriteAllText(path, doc.Serialize()); }
        catch (IOException) { /* transient; next edit retries */ }
    }

    public void Dispose()
    {
        _editor?.Dispose();
        _toSkia.Dispose();
    }
}
