using VL.Lib.Collections;

namespace VL.Automata.Engine;

// A one-cable snapshot of everything the running node reports about the machine this
// frame: the same values that come out of the individual output pins (Active State,
// Next State, State Frames, Transition Countdown, the four spreads), bundled into a
// single immutable object so downstream patches can pass "the whole automata" on one
// wire and unpack only what they need.
//
// It's a *snapshot*, not a live handle to the engine: a fresh (cheap) record is built
// each frame from the values the node has already computed/cached, so it's safe to
// hold, compare, or route without ever touching the mutable engine. The scalars are
// copied; the spreads are the node's cached spreads (themselves immutable), shared by
// reference — no per-frame copying of the state/transition/region lists.
public sealed record AutomataInfo(
    // Current state label (empty if the machine has no active state).
    string ActiveState,
    // Immutable id of the current state — stable across relabelling, for keying/compare.
    string ActiveStateId,
    // Target label of a pending multi-frame transition; empty when nothing is pending.
    string NextState,
    // "A to B" title of the pending transition (matches the Transition Titles / Fire names);
    // empty when nothing is pending.
    string PendingTransitionTitle,
    // True while a multi-frame transition is settling (NextState is then non-empty).
    bool IsTransitioning,
    // Frames spent settled in the current state (frozen while a transition runs).
    int StateFrames,
    // Pending transition progress, 1 → 0; 0 when nothing is pending.
    float TransitionCountdown,
    // Reset-target labels (one per state).
    Spread<string> States,
    // "A to B" transition titles — aligned with, and matching, the Fire pin names.
    Spread<string> TransitionTitles,
    // 1/0 per region, aligned with RegionNames.
    Spread<float> RegionActive,
    // Region names, aligned with RegionActive.
    Spread<string> RegionNames)
{
    // A harmless empty snapshot (e.g. before the first Update).
    public static readonly AutomataInfo Empty = new(
        "", "", "", "", false, 0, 0f,
        Spread<string>.Empty, Spread<string>.Empty,
        Spread<float>.Empty, Spread<string>.Empty);
}
