// welcome to your new op!
// have a look at the documentation:
// https://cables.gl/docs/5_writing_ops/dev_ops/dev_ops

const
    triggersJson = op.inString("Triggers JSON"),
    frameCountIn = op.inInt("Frame Count", 60),
    updateIn = op.inTrigger("Update"),
    activeStateOut = op.outObject("Active State"),
    frameCounterOut = op.outNumber("Frame Counter");

let activeState = null;
let startState = null;
let stateHistory = [];
let framesSinceStateSet = 0;

const createdTriggers = new Map();
let stateById = new Map();

function getTransitionInfos(data)
{
    if (data && typeof data === "object" && Array.isArray(data.transitions))
    {
        const stateLabels = new Map(
            Array.isArray(data.states)
                ? data.states
                    .filter((state) => state && typeof state.id === "string")
                    .map((state) => [
                        state.id,
                        typeof state.label === "string" && state.label.trim().length > 0
                            ? state.label
                            : state.id,
                    ])
                : []
        );

        return data.transitions
            .map((transition) =>
            {
                if (!transition || typeof transition.from !== "string" || typeof transition.to !== "string")
                {
                    return null;
                }

                const fromLabel = stateLabels.get(transition.from) || transition.from;
                const toLabel = stateLabels.get(transition.to) || transition.to;
                const name = `${fromLabel} to ${toLabel}`;
                return { name, transition };
            })
            .filter((info) => info && typeof info.name === "string" && info.name.trim().length > 0);
    }

    return [];
}

function ensureTrigger(name, transition)
{
    const safeName = String(name).trim();
    if (!safeName || createdTriggers.has(safeName)) return;

    const trigger = op.inTriggerButton(safeName);
    trigger.onTriggered = () =>
    {
        if (!transition) return;

        const minFrames = Math.max(0, frameCountIn.get() | 0);
        if (activeState && framesSinceStateSet < minFrames)
        {
            return;
        }

        if (transition.to === "__START__")
        {
            stateHistory = [];
            setActiveState(startState);
            return;
        }

        if (transition.to === "__PREVIOUS__")
        {
            if (stateHistory.length === 0) return;
            setActiveState(stateHistory.pop() || null, false);
            return;
        }

        if (!activeState) return;

        if (typeof activeState.id === "string" && activeState.id === transition.from)
        {
            const nextState = stateById.get(transition.to) || null;
            if (nextState !== activeState)
            {
                stateHistory.push(activeState);
            }
            setActiveState(nextState, false);
        }
    };

    createdTriggers.set(safeName, { trigger, transition });
}

function removeTrigger(name)
{
    const entry = createdTriggers.get(name);
    if (!entry) return;

    const trigger = entry.trigger || entry;

    if (typeof op.removePort === "function")
    {
        op.removePort(trigger);
    }
    else if (typeof trigger.remove === "function")
    {
        trigger.remove();
    }

    createdTriggers.delete(name);
}

function buildTriggersFromJson()
{
    let data;
    try
    {
        data = JSON.parse(triggersJson.get() || "[]");
    }
    catch (err)
    {
        return;
    }

    if (data && typeof data === "object" && Array.isArray(data.states))
    {
        stateById = new Map(
            data.states
                .filter((state) => state && typeof state.id === "string")
                .map((state) => [state.id, state])
        );

        startState = data.states.find((state) =>
            state && typeof state.label === "string" && state.label.trim() === "START"
        ) || null;
        stateHistory = [];
        setActiveState(startState);
    }

    const transitionInfos = getTransitionInfos(data);
    const nameSet = new Set(transitionInfos.map((info) => info.name));

    nameSet.add("RESET");
    nameSet.add("PREVIOUS");

    Array.from(createdTriggers.keys())
        .filter((name) => !nameSet.has(name))
        .forEach(removeTrigger);

    transitionInfos.forEach((info) => ensureTrigger(info.name, info.transition));
    ensureTrigger("RESET", { from: "__ANY__", to: "__START__" });
    ensureTrigger("PREVIOUS", { from: "__ANY__", to: "__PREVIOUS__" });
}

function setActiveState(nextState, resetHistory = true)
{
    if (resetHistory)
    {
        stateHistory = [];
    }

    activeState = nextState || null;
    framesSinceStateSet = 0;
    activeStateOut.set(activeState);
    frameCounterOut.set(framesSinceStateSet);
}

op.onFrame = () =>
{
    framesSinceStateSet += 1;
    frameCounterOut.set(framesSinceStateSet);
};

updateIn.onTriggered = op.onFrame;

triggersJson.onChange = buildTriggersFromJson;
buildTriggersFromJson();
