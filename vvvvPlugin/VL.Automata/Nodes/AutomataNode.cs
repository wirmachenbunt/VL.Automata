using VL.Automata.Engine;
using VL.ImGui;
using VL.Lib.Collections;
using VL.Skia;

namespace VL.Automata;

// The Automata FSM node for vvvv gamma — the [ProcessNode] port of the cables op
// Ops.Local.Automata. (A node factory would give one bang pin per transition, but
// that only runs from a deployed vvvv package; as a referenced project vvvv imports
// the [ProcessNode], so transitions/regions are exposed via spreads.)
//
// Firing a transition: set 'Transition' to a transition's id or "A to B" title
// (read the choices off the 'Transition Ids' / 'Transition Titles' outputs) and
// bang 'Fire'. On Fire's rising edge the selected transition fires — only when it's
// valid from the current state with nothing pending. To drive different transitions
// from different events, switch 'Transition' per event and bang 'Fire'.
//
// 'Path' points at a .automata file (same JSON as the cables op). 'Editor' is the
// editor as a Skia ILayer; wire it into a renderer (Space = DIPTopLeft). Editing
// reloads the engine and saves the file.
[ProcessNode(Name = "Automata", Category = "Automata")]
public class AutomataNode : IDisposable
{
    private readonly AutomataEngine _engine = new();
    // Wraps the ImGui editor widget as a Skia layer, so the node can output an
    // ILayer directly — no ToSkiaLayer node needed in the patch. Held per instance
    // because it owns the Skia render state.
    private readonly ToSkiaLayer _toSkia = new();
    private AutomataEditorWidget? _editor;
    private string _loadedPath = "\0"; // sentinel so first Update always loads
    private bool _docDirty;
    private bool _prevReset;
    private bool _prevFire;

    public void Update(
        string? path,
        bool advance,
        string? resetTarget,
        bool reset,
        bool fire,
        string? transition,
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

        // Fire the selected transition on Fire's rising edge (by id or title).
        if (fire && !_prevFire && !string.IsNullOrEmpty(transition))
        {
            foreach (var t in transitions)
            {
                if (t.Id == transition || t.Title == transition) { _engine.FireTransition(t.Id); break; }
            }
        }
        _prevFire = fire;

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

        // Wrap the ImGui widget into a Skia layer for direct output.
        editor = _editor is null
            ? null
            : _toSkia.Update(_editor.Widget, dockingEnabled: false, fonts: Spread<FontConfig>.Empty, fullscreenWindow: false, Style: null);
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
        _prevFire = false;
        _prevReset = false;
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
