namespace VL.Automata.Engine;

// Pure state-machine core — a near-literal port of the engine half of the cables
// op Ops.Local.Automata.js. No vvvv / ImGui references, so it compiles and can be
// unit-tested standalone, and reads as a line-by-line diff against the original.
//
// The op's dynamic ports and UI are NOT here: the node factory reads the pin
// descriptors this class exposes (TransitionPins / RegionPins / ResetTargets) to
// build gamma pins, and drives the machine through FireTransition / StepFrame /
// Reset. Outputs are plain properties read back onto output pins each frame.
public sealed class AutomataEngine
{
    public const double StateRadius = 96.0; // state circle radius (visual + containment)

    // --- Pin descriptors derived from the document (consumed by the factory) ---
    public readonly record struct TransitionPin(string Id, string Title, string From, string To, int Frames);
    public readonly record struct RegionPin(string Id, string Name);
    public readonly record struct ResetTarget(string Id, string Label);

    private sealed class Pending
    {
        public string Id = "";
        public string From = "";
        public string To = "";
        public int Frames;
        public int Elapsed;
    }

    private AutomataDocument _doc = new();
    private string? _activeStateId;
    private int _stateFrames;
    private Pending? _pending;

    // Bumped on every Load — i.e. whenever the states/transitions/regions sets are
    // rebuilt. Lets consumers (the node) cache anything derived from the document
    // (output spreads, the Fire pin group) and rebuild only when this changes, instead
    // of re-deriving it every frame. Active-state changes don't bump it (the sets are
    // unaffected); track ActiveStateId separately for anything that depends on it.
    private int _version;

    private List<TransitionPin> _transitionPins = new();
    private List<RegionPin> _regionPins = new();
    private List<ResetTarget> _resetTargets = new();

    // ---- Outputs (read back onto pins) --------------------------------------
    // Rebuild-generation of the document-derived sets (see _version). Changes only on Load.
    public int Version => _version;
    public string? ActiveStateId => _activeStateId;
    // Id of the transition currently in progress (multi-frame), for editor highlight.
    public string? PendingTransitionId => _pending?.Id;
    public string ActiveState => _activeStateId is null ? "" : GetStateLabel(_activeStateId);
    public string NextState => _pending is null ? "" : GetStateLabel(_pending.To);
    // "A to B" title of the transition currently in progress (empty when none) — same
    // format as the transition pins (BuildTransitionPins), for the active-transition output.
    public string PendingTransitionTitle =>
        _pending is null ? "" : $"{GetStateLabel(_pending.From)} to {GetStateLabel(_pending.To)}";
    public int StateFrames => _stateFrames;
    public double TransitionCountdown => GetNormalizedTransitionCountdown();
    public IReadOnlyList<string> States => _resetTargets.Select(t => t.Label).ToList();

    public IReadOnlyList<TransitionPin> TransitionPins => _transitionPins;
    public IReadOnlyList<RegionPin> RegionPins => _regionPins;
    public IReadOnlyList<ResetTarget> ResetTargets => _resetTargets;

    // 1/0 whether the active state sits inside the given region (by id).
    public float RegionActive(string regionId)
    {
        var region = _doc.Regions.FirstOrDefault(r => r is not null && r.Id == regionId);
        if (region is null) return 0f;
        var active = _doc.States.FirstOrDefault(s => s is not null && s.Id == _activeStateId);
        return IsStateInsideRegion(active, region) ? 1f : 0f;
    }

    // ---- Loading / rebuild (parseStoredData + rebuildTriggers) --------------
    public void Load(string? storedJson) => Load(AutomataDocument.Parse(storedJson));

    public void Load(AutomataDocument doc)
    {
        _doc = doc ?? new AutomataDocument();
        _version++; // the document-derived sets below are being rebuilt
        BuildResetTargets();
        BuildTransitionPins();
        BuildRegionPins();

        // Drop a pending transition whose edge no longer exists (rebuildTriggers).
        if (_pending is not null)
        {
            bool stillValid = _doc.Transitions.Any(t =>
                t is not null && t.Id == _pending.Id && t.From == _pending.From && t.To == _pending.To);
            if (!stillValid) CancelPendingTransition();
        }

        // Keep the active state valid, else fall back to START / first state.
        bool stillExists = _activeStateId is not null &&
            _doc.States.Any(s => s is not null && s.Id == _activeStateId);
        if (!stillExists)
        {
            var start = _doc.States.FirstOrDefault(IsStartState);
            var fallback = start ?? _doc.States.FirstOrDefault();
            SetActiveStateId(fallback?.Id);
        }
    }

    // ---- Commands -----------------------------------------------------------

    // One simulation step. The node calls this once per vvvv frame (every Update), so
    // counting steps makes "frames" a real frame count (advanceFrame in the cables op).
    public void StepFrame()
    {
        if (_pending is not null)
        {
            // Mid-transition: advance the transition, but freeze the state frame counter —
            // it only counts time actually spent settled in a state, not while moving between.
            _pending.Elapsed += 1;
            if (_pending.Elapsed >= _pending.Frames)
            {
                var next = _pending.To;
                _pending = null;
                SetActiveStateId(next); // resets stateFrames to 0; counting resumes next frame
            }
        }
        else
        {
            _stateFrames += 1;
        }
    }

    // Fire a transition by its (immutable) id — only from its own from-state and
    // only when no other transition is already pending.
    public void FireTransition(string transitionId)
    {
        if (_pending is not null) return;
        var t = _doc.Transitions.FirstOrDefault(x => x is not null && ResolveTransitionId(x) == transitionId);
        if (t is null) return;
        if (_activeStateId != t.From) return;
        StartTransition(t);
    }

    public void Reset(string? selectedResetLabel)
    {
        var targetId = GetResetTargetId(selectedResetLabel);
        if (targetId is null) return;
        CancelPendingTransition();
        SetActiveStateId(targetId);
    }

    // Editor shortcut (Ctrl+click a state): jump straight to that state.
    public void ForceState(string id)
    {
        if (!_doc.States.Any(s => s is not null && s.Id == id)) return;
        CancelPendingTransition();
        SetActiveStateId(id);
    }

    // Editor shortcut (Ctrl+click a transition): run it regardless of the current
    // state — cancel any pending one, jump to its "from", then start it.
    public void ForceTransition(string transitionId)
    {
        var t = _doc.Transitions.FirstOrDefault(x => x is not null && ResolveTransitionId(x) == transitionId);
        if (t is null) return;
        CancelPendingTransition();
        if (_activeStateId != t.From) SetActiveStateId(t.From);
        StartTransition(t);
    }

    // ---- Internals (mirrors of the JS helpers) ------------------------------

    private static int SanitizeFrames(int value) => value >= 0 ? value : 0;

    private void StartTransition(TransitionData transition)
    {
        int frames = SanitizeFrames(transition.Frames);
        if (frames <= 0)
        {
            CancelPendingTransition();
            SetActiveStateId(transition.To);
            return;
        }
        _pending = new Pending
        {
            Id = ResolveTransitionId(transition),
            From = transition.From,
            To = transition.To,
            Frames = frames,
            Elapsed = 0
        };
    }

    private void CancelPendingTransition() => _pending = null;

    private void SetActiveStateId(string? id)
    {
        _activeStateId = id;
        _stateFrames = 0;
    }

    private double GetNormalizedTransitionCountdown()
    {
        if (_pending is null || _pending.Frames <= 0) return 0;
        int remaining = Math.Max(_pending.Frames - _pending.Elapsed, 0);
        return (double)remaining / _pending.Frames;
    }

    private string GetStateLabel(string id)
    {
        var s = _doc.States.FirstOrDefault(x => x is not null && x.Id == id);
        return s is not null && !string.IsNullOrWhiteSpace(s.Label) ? s.Label : id;
    }

    private static bool IsStartState(StateData? s) =>
        s is not null && !string.IsNullOrEmpty(s.Id) && s.Label?.Trim() == "START";

    private static bool IsStateInsideRegion(StateData? state, RegionData? region)
    {
        if (state is null || region is null) return false;
        double dx = state.X - region.X;
        double dy = state.Y - region.Y;
        return Math.Sqrt(dx * dx + dy * dy) <= region.Radius + StateRadius;
    }

    private static string ResolveTransitionId(TransitionData t) =>
        !string.IsNullOrWhiteSpace(t.Id) ? t.Id : $"{t.From}-to-{t.To}";

    private void BuildTransitionPins()
    {
        _transitionPins = _doc.Transitions
            .Where(t => t is not null && t.From is not null && t.To is not null)
            .Select(t => new TransitionPin(
                ResolveTransitionId(t),
                $"{GetStateLabel(t.From)} to {GetStateLabel(t.To)}",
                t.From, t.To, SanitizeFrames(t.Frames)))
            .Where(p => !string.IsNullOrWhiteSpace(p.Id))
            .ToList();
    }

    // One pin per region: the immutable Id (used to look up activity) plus the region's
    // display Name (its title, falling back to the id) for the Region Names output.
    private void BuildRegionPins()
    {
        _regionPins = new List<RegionPin>();
        foreach (var region in _doc.Regions)
        {
            if (region is null || string.IsNullOrEmpty(region.Id)) continue;
            _regionPins.Add(new RegionPin(region.Id, GetRegionTitle(region)));
        }
    }

    private static string GetRegionTitle(RegionData region) =>
        !string.IsNullOrWhiteSpace(region.Title) ? region.Title.Trim() : region.Id;

    // Reset-target labels, disambiguated with the id when a label repeats.
    private void BuildResetTargets()
    {
        var counts = new Dictionary<string, int>();
        foreach (var s in _doc.States)
        {
            if (s is null || string.IsNullOrEmpty(s.Id)) continue;
            string baseLabel = !string.IsNullOrWhiteSpace(s.Label) ? s.Label.Trim() : s.Id;
            counts[baseLabel] = counts.TryGetValue(baseLabel, out var c) ? c + 1 : 1;
        }

        _resetTargets = _doc.States
            .Where(s => s is not null && !string.IsNullOrEmpty(s.Id))
            .Select(s =>
            {
                string baseLabel = !string.IsNullOrWhiteSpace(s.Label) ? s.Label.Trim() : s.Id;
                string label = counts.TryGetValue(baseLabel, out var c) && c > 1 ? $"{baseLabel} ({s.Id})" : baseLabel;
                return new ResetTarget(s.Id, label);
            })
            .ToList();
    }

    private string? GetStartStateId() => _doc.States.FirstOrDefault(IsStartState)?.Id;

    private string? GetDefaultResetTargetId() =>
        GetStartStateId() ?? (_resetTargets.Count > 0 ? _resetTargets[0].Id : null);

    private string? GetResetTargetId(string? selectedLabel)
    {
        var target = _resetTargets.FirstOrDefault(t => t.Label == selectedLabel);
        return target.Id is { Length: > 0 } ? target.Id : GetDefaultResetTargetId();
    }
}
