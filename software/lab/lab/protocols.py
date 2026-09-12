"""protocols.py - what the page tells the person to do, and when.

A protocol is a list of phases. Each phase has a duration and an
instruction; the server steps through them on its clock, writes every
transition to events.csv, and the page only displays what the server says.
So "GO" is one timestamp, taken once, on the same clock as the camera and
the device.

The two comparison protocols are identical on purpose. The bare finger and
the finger wearing the device get the same rest, the same countdown, the
same two blocks: ten seconds of flexion-extension at a comfortable pace, and
ten seconds as fast as possible. That is what makes "x % slower" a fair
number rather than a mood.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Phase:
    key: str
    seconds: float
    title: str
    instruction: str
    countdown: bool = False     # show the big 3-2-1 during this phase
    record: bool = True          # camera + device recording during this phase
    neutral: bool = False        # this phase defines "straight": angles are zeroed on it
    block: str = ""              # analysis block label ("comfortable", "fast", "follow", "target")
    target: dict | None = None   # assisted protocol: the pose to reach


@dataclass
class Protocol:
    key: str
    name: str
    summary: str
    setup: list[str]
    phases: list[Phase]
    follow: bool = False         # stream camera poses to the device follower
    targets: bool = False        # the assisted protocol: device drives to targets
    comparison: str = ""         # which protocol this is compared against

    @property
    def duration_s(self) -> float:
        return sum(p.seconds for p in self.phases)


def _motion_block(prefix: str) -> list[Phase]:
    return [
        Phase(f"{prefix}rest", 3.0, "Rest", "Hand flat, index finger straight and relaxed. Hold still.", neutral=True),
        Phase(f"{prefix}count1", 3.0, "Ready", "Comfortable pace next: flex and extend the index finger fully, again and again.", countdown=True),
        Phase(f"{prefix}comfortable", 10.0, "Move", "Flex and extend at a comfortable pace. Full range every time.", block="comfortable"),
        Phase(f"{prefix}rest2", 3.0, "Rest", "Straight and still.", neutral=False),
        Phase(f"{prefix}count2", 3.0, "Ready", "As fast as you can next: full flexion to full extension.", countdown=True),
        Phase(f"{prefix}fast", 10.0, "Move fast", "As fast as you can. Full range every time.", block="fast"),
        Phase(f"{prefix}rest3", 2.0, "Done", "Relax.", record=True),
    ]


PROTOCOLS: dict[str, Protocol] = {
    "bare": Protocol(
        "bare", "Bare finger",
        "The index finger alone: the reference every other take is measured against.",
        ["Nothing on the hand.", "Forearm on the table, hand on its side so the camera sees the index finger from the side.",
         "Fill the frame: the hand between the two guide lines."],
        _motion_block(""), comparison=""),
    "worn": Protocol(
        "worn", "Finger in TAKTO",
        "The same movement wearing the device, motors off. Camera and encoders record together.",
        ["TAKTO ONE worn on the index finger, motors off (transparent).", "Bridge running, encoders reading (the device panel shows live degrees).",
         "Same hand placement as the bare take."],
        _motion_block(""), comparison="bare"),
    "follow": Protocol(
        "follow", "Robot follows",
        "The bare finger moves, the device copies it: every pose in order, as late as it must be.",
        ["Device on the table, finger mechanism string-coupled and free to move; nobody wears it.",
         "Bridge running, camera follow: neutral captured, directions measured, armed (the device panel shows it).",
         "Your bare hand on the left of the frame, the device on the right."],
        [
            Phase("rest", 3.0, "Rest", "Index finger straight and relaxed. Hold still.", neutral=True),
            Phase("count", 3.0, "Ready", "Move freely next: the device will follow, pose by pose.", countdown=True),
            Phase("follow", 20.0, "Move", "Move the index finger freely. Slow, fast, hold, release.", block="follow"),
            Phase("drain", 8.0, "Wait", "Hold still. The device is finishing the poses it still owes.", block="drain"),
            Phase("done", 2.0, "Done", "Relax.", record=True),
        ], follow=True),
    "assisted": Protocol(
        "assisted", "Assisted targets",
        "Wearing the device with the motors active: a target pose is named, the device drives to it, the time to arrive is measured.",
        ["TAKTO ONE worn, motors on, camera follow armed.", "Hand relaxed; let the device move the finger."],
        [Phase("rest", 3.0, "Rest", "Relax the finger. Let the device hold it.", neutral=True)] + [
            p for i, (m, pp) in enumerate([(15, 20), (30, 40), (10, 45), (35, 25), (25, 45), (0, 0)])
            for p in (
                Phase(f"t{i}_show", 2.0, f"Target {i + 1}", f"Next: MCP {m}°, PIP {pp}°. Relax.", countdown=True),
                Phase(f"t{i}_go", 6.0, f"Target {i + 1}", f"MCP {m}°, PIP {pp}°. The device is driving.", block="target", target={"mcp_deg": m, "pip_deg": pp}),
            )
        ] + [Phase("done", 2.0, "Done", "Relax.", record=True)],
        follow=False, targets=True),
}
