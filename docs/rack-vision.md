# Rack Vision

Some faults are not in any configuration: a pulled patch cord, a cable in the wrong port, a dead
transceiver. Rack Vision lets netmedic see them through the technician's phone.

## On the phone

Open `https://<netmedic>:8080/vision` (served by `netmedic watch --lan`) and point the camera at
the rack:

- **Live ports** — SAM 3.1 segments *empty ethernet port* and *ethernet cable plug* on the video
  every 1–2 s; the boxes stay glued to the ports between refreshes thanks to motion tracking in
  the browser (iPhone Safari has no WebXR: this is an AR-style overlay on `<video>`).
- **Scan** — the shutter freezes the frame and sends it for a deep analysis (below); findings are
  drawn on the photo and listed with their severity.
- **Cable trace** — tap a port: Muse Spark follows that cable through the photo and draws its
  path, with where it ends and a confidence.

## The deep scan — `vision.py`

1. **Muse Spark vision** receives the photo and the live network state as text: active symptoms,
   unreachable devices and the expected cabling (`cabling.yaml`, *switch port → router interface*).
   It returns devices and findings (unplugged or loose cables, empty ports the plan expects,
   wrong ports, LEDs off, contradictions with the live data), each with a bounding box.
2. **SAM 3.1** runs in parallel on the same photo.
3. **Cross-check** — every finding that claims an empty port is checked against SAM's boxes and
   marked *confirmed*, *unclear* or *disputed*. This exists because Spark, primed by a symptom,
   sometimes "saw" the empty port it was told to look for; the prompt also tells it that the live
   data says where to look, never what to see.

## Asked by the agent

During an investigation, when a link is down at layer 1 (`NO-CARRIER` on one or both ends) and
nothing in the configuration explains it, the agent calls `request_rack_photo`:

1. the live incident shows *Rack Vision photo · edge1 to-core1* with an **Open Rack Vision** button;
2. the phone shows *netmedic needs a photo · edge1 to-core1* and the evidence;
3. the next scan is analysed knowing what the agent is looking for, and its findings are returned
   to the agent as the tool result;
4. the agent cannot re-plug a cable: the incident ends **escalated** with the port and what the
   photo showed. If no photo arrives within 3 minutes, it escalates an on-site check anyway.

Reproduce it in the lab with `lab/chaos.sh cable-unplug`, which pulls the virtual patch cord
between edge1 and core1 (real carrier loss in both VMs, configuration untouched). In our runs the
agent requested the photo 8–18 s after detection and closed the incident as escalated in under a
minute, for about $0.004.

## Phone setup

1. `netmedic watch --lan` prints an HTTPS URL with an access token and its QR code.
2. First time only: open `https://<ip>:8080/ca.crt` on the iPhone, install the profile, then trust
   it in *Settings → General → About → Certificate Trust Settings*.
3. Scan the QR code. The camera needs HTTPS; without it the page falls back to photo upload.
