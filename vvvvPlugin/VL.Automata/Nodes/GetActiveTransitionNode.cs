using VL.Automata.Engine;

namespace VL.Automata;

// Splitter for the Automata node's `Automata` output (AutomataInfo): pulls out the
// pending (multi-frame) transition. `Transition Title` is its "A to B" name, `Next State`
// the state it's heading to, `Transition Countdown` its progress 1 → 0 — all empty/0 when
// nothing is pending. The sibling of GetActiveState; same zero-field [ProcessNode] pattern.
[ProcessNode(Name = "GetActiveTransition", Category = "Automata")]
public class GetActiveTransitionNode
{
    // A null/unconnected input yields empty/0 rather than throwing.
    public void Update(
        AutomataInfo? automata,
        out string transitionTitle,
        out string nextState,
        out float transitionCountdown)
    {
        transitionTitle = automata?.PendingTransitionTitle ?? "";
        nextState = automata?.NextState ?? "";
        transitionCountdown = automata?.TransitionCountdown ?? 0f;
    }
}
