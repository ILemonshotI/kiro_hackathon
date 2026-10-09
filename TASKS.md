# TASKS: Character Voice Agent

Source of truth: `README.md` + `REQUIREMENTS.md`. They win over anything here.
Legend: `[P]` = can run in parallel with other `[P]` tasks of the same group (different files).
Every task ends with a manual test. Commit after each phase (`git add <files>`, never `.env`).

---

## Requirements checklist

### Stack and rules
- [x] Python 3.12+, FastAPI + uvicorn, managed with uv; packages: `fastapi`, `uvicorn[standard]`, `python-dotenv`, `boto3`, `langgraph`, `langchain-aws` (+ `aws-sdk-transcribe-streaming[awscrt]` for bonus A)
- [x] `main.py` with `app = FastAPI()` and `pyproject.toml` at repo top; `main.py` serves `public/`
- [ ] Runs with `uv run uvicorn main:app --reload` on http://localhost:8000
- [ ] Frontend: plain HTML/CSS/JS modules, import map, CDN only: three 0.186.1, three/addons, @pixiv/three-vrm 3.5.5. No npm, no build, no React
- [x] One WebSocket per page at `/ws`, JSON messages (binary frames only for mic audio)
- [x] LangGraph agent, `ChatBedrockConverse`, model `us.amazon.nova-lite-v1:0`, `region_name="us-east-1"`
- [x] Polly neural voice; `region_name="us-east-1"` on every boto3 client
- [ ] Keys only from `.env` via python-dotenv; never hard-coded, printed, or sent to the browser; app also runs without `.env`
- [x] `character.json`: `name`, `avatar` (`/avatars/CoolPineapple.vrm`), `voice`, `personality`, `greeting`, `background` (2 colors) (+ `moves` for bonus B). Personality stays server-side
- [x] Assets not renamed or replaced
- [ ] Few files, simple code; friendly content (big screen); only allowed assets; solo, built with Kiro

### Milestones
- [ ] M1: full-body avatar facing camera, colored background, `idle` loop, blinks; "Click to start" → `fall-flat` → `stand-up` → `idle`
- [ ] M2: text box + Send (Enter sends) over WS; Nova Lite answers in character; memory while page is open; 1–3 sentences, no lists/emojis; one answer at a time (Send disabled); input cut to 500 chars; friendly error + retry
- [ ] M3: Polly speaks every answer with `character.json` voice; lip sync from visemes; speech bubble while speaking
- [ ] M4: AI-chosen emotion (`neutral|happy|angry|sad|relaxed`) on face while speaking; `thinking` while waiting, `talking` while speaking, `idle` otherwise, smooth crossfades; Dance button (loop + `dance.mp3`, toggles, sending a message stops it)
- [ ] M5: greeting spoken after "Click to start"; own name, personality, greeting, voice, colors

### Bonuses
- [ ] A: hold button / Space (not while typing) → mic streams to server → Transcribe → live words → `thinking` → answered like typed text; 30 s cap; button hidden unless `localhost` or `https`
- [ ] B: `moves` in `character.json` (file + `when`); AI picks `move` or `none`; looping moves start after voice ends
- [ ] C: tools (dice, quiz score, facts), effects, extra Mixamo moves
- [ ] D: deployed to own server via fork + SSM `deploy`

### Added by us (within README limits)
- [ ] Structured output with safe fallback (`emotion=neutral`, `move=none` on invalid output)
- [ ] States: idle → listening → thinking → speaking → idle
- [ ] Any service failure: short fallback line, character returns to idle

---

## Architecture (summary)

- Files: `main.py` (FastAPI, `/ws`, static), `agent.py` (LangGraph + Nova Lite), `speech.py` (Polly), `stt.py` (Transcribe, bonus A), `character.json`, `public/index.html`, `public/style.css`, `public/app.js` (scene, UI, state machine), `public/mixamo.js` (retargeting), `public/mic-worklet.js` (bonus A).
- Split per file so parallel agents never edit the same file.

### WebSocket contract (`/ws`)
Client → server
- `{"type":"start"}` after "Click to start" → server sends greeting
- `{"type":"chat","text":"..."}` (server cuts to 500 chars)
- `{"type":"mic_start"}`, binary PCM16 16 kHz frames (100 ms), `{"type":"mic_stop"}` (bonus A)

Server → client
- `{"type":"config","name","avatar","background":[c1,c2],"moves":[names]}` on connect (no personality)
- `{"type":"thinking"}` when work starts
- `{"type":"transcript","text","final":bool}` (bonus A)
- `{"type":"reply","text","emotion","move","audio":"<base64 mp3>|null","visemes":[{"time":ms,"value":"a"}],"fallback":bool}`
- `{"type":"error","message":"short friendly text"}`

### AWS
- Bedrock: `us.amazon.nova-lite-v1:0` (US cross-region inference profile), `us-east-1`.
- Transcribe: streaming (needed for live words; boto3 can't stream, use `aws-sdk-transcribe-streaming`).
- Permissions the app needs (already granted by the event key / server role, nothing to create): `bedrock:InvokeModel` (Converse) on the profile + Nova Lite foundation model, `polly:SynthesizeSpeech`, `transcribe:StartStreamTranscription`.
- Deploy: organizer EC2 instance via `aws ssm start-session` + `deploy <fork-url>`.

---

## Phase 0: Setup and credentials (serial)

- [ ] 0.1 Check tools: `python --version` (≥3.12), `uv --version`, `git --version`, `aws --version`.
  Test: all four print versions.
- [ ] 0.2 `.env` inside `kiro-hackathon/` (copy of `.env.example`, user fills key; agent never reads it). A `.env` exists one folder up: move it in.
  Test: `git status` does not list `.env`.
- [x] 0.3 `uv init` (bare, Python ≥3.12) + `uv add` the 6 core packages (`uv.lock` pins exact versions).
  Test: `uv run python -c "import fastapi, langgraph, langchain_aws, boto3, dotenv"`.
- [x] 0.4 Throwaway smoke script (deleted after): one Converse call to Nova Lite, one Polly `synthesize_speech`.
  Test: both succeed; no key printed.

## Phase 1: M1 character appears (frontend)  `[P]` with Phase 2.1–2.2 and 3.1

- [x] 1.1 `main.py` minimal: `app = FastAPI()`, `load_dotenv()`, `/ws` stub, `StaticFiles(directory="public", html=True)` mounted at `/` last.
  Test: run server; `/avatars/CoolPineapple.vrm` returns 200.
- [ ] 1.2 `index.html` (import map), `style.css` (gradient background), `app.js`: renderer `alpha:true`, camera `(30, aspect, 0.1, 20)` at `(0,1,4)` → `(0,0.75,0)`, load VRM, `rotateVRM0`, `frustumCulled=false`, loop `mixer.update → vrm.update → render`.
  Test: avatar full body, facing camera, no console errors.
- [ ] 1.3 `mixamo.js`: retarget per Technical notes (bone map, `P×q×R⁻¹`, VRM0 x/z negate, hips scale). Play `idle` loop.
  Test: breathing idle, no T-pose, no twisted limbs or fingers.
- [ ] 1.4 Blink every 2–6 s via `expressionManager.setValue("blink")`.
  Test: no errors. NOTE: this avatar has no blink morph (see Risks), so no visible blink.
- [ ] 1.5 "Click to start" overlay → `AudioContext.resume()` → `fall-flat` (LoopOnce, clamp) → `stand-up` (start 2.5 s, timeScale 1.6) → crossfade 0.4 to `idle`.
  Test: intro plays once, smoothly, ends in idle.

## Phase 2: M2 it thinks (backend + Nova Lite)

- [x] 2.1 `[P]` `character.json` with all fields (placeholder personality until Phase 5).
  Test: `uv run python -c "import json;print(json.load(open('character.json'))['name'])"`.
- [x] 2.2 `[P]` `agent.py`: Pydantic `Reply(text, emotion: Literal[5])`, `ChatBedrockConverse(model="us.amazon.nova-lite-v1:0", region_name="us-east-1").with_structured_output(Reply)`, `StateGraph(MessagesState)` + `InMemorySaver`, `thread_id` per socket, trim to last 20 messages, system prompt = personality + rules (1–3 sentences, no lists/emojis, friendly, stay in character). Invalid output → `emotion="neutral"`.
  Test: script asks "My name is Sam" then "What's my name?" on one thread_id → remembers.
- [x] 2.3 `/ws`: send `config` on connect; on `chat`: cut 500, send `thinking`, call agent (`ainvoke` / thread), send `reply`; one request at a time per socket; exception → `error`.
  Test: via Phase 2.4 UI.
- [ ] 2.4 Chat UI in `app.js`: input + Send, Enter sends, disabled while waiting, shows reply text, shows error and re-enables.
  Test: 3 messages with memory; Send disabled while waiting; stop server mid-request → friendly error, retry works after restart.

## Phase 3: M3 it speaks (Polly + lip sync)

- [x] 3.1 `[P]` `speech.py`: `synthesize(text, voice)` runs two Polly calls in parallel threads (mp3; json with `["viseme","word"]`), `Engine="neural"`, returns `(mp3_bytes, marks)`.
  Test: script prints mp3 size and first 5 visemes.
- [x] 3.2 `reply` carries base64 mp3 + visemes; Polly failure → `audio: null`, text still shown.
  Test: browser devtools WS frame shows `audio` and `visemes`.
- [ ] 3.3 Playback: one `AudioContext`, `decodeAudioData`, `AudioBufferSourceNode`, record `startTime`.
  Test: voice is heard after click.
- [ ] 3.4 Lip sync each frame: `now=(ctx.currentTime-startTime-(ctx.outputLatency||0))*1000`, last viseme ≤ now, README mapping table, others 0.
  Test: mouth matches speech, closes on silence and end.
- [ ] 3.5 Speech bubble visible during playback, hidden on `ended`.
  Test: bubble appears and disappears with audio.

## Phase 4: M4 it feels and moves

- [ ] 4.1 Emotion on face while speaking (~0.7, short ease in/out), back to 0 after.
  Test: "tell me something sad" → sad face while speaking.
- [ ] 4.2 State machine `idle → listening → thinking → speaking → idle` → clips `idle / idle / thinking / talking / idle`, `crossFadeTo(next, 0.4)`.
  Test: thinking while waiting, talking while audio plays, idle after; no snapping.
- [ ] 4.3 Dance button: `dance` loop + `dance.mp3`; press again or send a message → stop, back to idle.
  Test: all three paths.

## Phase 5: M5 it's yours

- [x] 5.1 Real `name`, `personality`, `greeting`, `voice`, `background` (user provides).
  Test: colors and voice change after reload.
- [x] 5.2 Greeting: client sends `start` after the intro; server speaks `greeting` (fixed text, emotion `happy`) and stores it as the first AI message.
  Test: greeting spoken once per page load.
- [x] 5.3 Fallback line: Bedrock failure → in-character canned line spoken with Polly (`fallback:true`); Polly failure → bubble only; always end in idle.
  Test: temporarily break the model ID → fallback spoken, Send re-enabled; revert.

## Phase 6: Bonus B moves

- [ ] 6.1 `moves` in `character.json` (`name`, `file`, `when`, `loop`); `Reply.move` = `Literal[names..., "none"]` built from config; `when` texts in system prompt; invalid → `none`.
  Test: agent script "can you dance?" → `move="dance"`.
- [ ] 6.2 Frontend: one-shot moves play then return to idle; looping moves start after voice ends; sending stops them.
  Test: ask to dance → speaks, then dances with music.

## Phase 7: Bonus C superpowers

- [ ] 7.1 `[P]` Tools in `agent.py`: `roll_dice(count, sides)`, `quiz_score(change)` (per thread), `fun_fact(topic)`. Graph: `tools` node calls `bind_tools` once → run any calls → `answer` node (structured output). No loop.
  Test: "roll two dice" → reply has real numbers; server log shows the tool call.
- [ ] 7.2 `[P]` Optional effect (e.g. CSS confetti on dice or `happy`).
  Test: visible effect, no console errors.

## Phase 8: Bonus A it listens (Transcribe)

- [ ] 8.1 `[P]` `uv add "aws-sdk-transcribe-streaming[awscrt]"`; `stt.py`: one reused `AsyncTranscribeStreamingClient` (`AWSCRTHTTPClient`, us-east-1), `en-US`, 16000, `pcm`; async session: feed chunks, yield partial/final text, close input on stop.
  Test: feed Polly `OutputFormat="pcm", SampleRate="16000"` audio → transcript matches the text.
- [ ] 8.2 `/ws`: `mic_start`, binary frames, `mic_stop`; 30 s cap; partials → `transcript`; final → same path as `chat`; empty → friendly "I didn't catch that".
  Test: script sends Polly PCM over WS → gets transcript + reply.
- [ ] 8.3 `[P]` `mic-worklet.js`: average-downsample to 16 kHz, Int16, post 100 ms (3200-byte) chunks.
  Test: console logs ~10 chunks/s of 3200 bytes.
- [ ] 8.4 Hold-to-talk button + Space (ignored while typing); state `listening`; live words; hidden unless `localhost`/`https`.
  Test: speak → live words → thinking → spoken answer; 30 s auto-stop.

## Phase 9: Bonus D deploy (can be pulled forward right after Phase 5)

- [ ] 9.1 Run without `.env` (rename temporarily): server starts, no crash at import.
  Test: page loads; restore `.env`.
- [ ] 9.2 Fork, `git remote add mine ...`, `git status` without `.env`, `git push mine HEAD:main` (user confirms before push).
  Test: `git remote -v` shows `mine` with user's name; fork contains `main.py`, `pyproject.toml`.
- [ ] 9.3 `aws configure` (us-east-1, json), `aws ssm start-session --target <i-...>`, `deploy <fork-url>`.
  Test: `http://<server-ip>` works by typing; `logs` clean.

## Phase 10: Final check

- [ ] 10.1 Walk every box in the Requirements checklist in the browser.
- [ ] 10.2 Secrets: `git ls-files` has no `.env`; `git log -p | Select-String "AWS_SECRET_ACCESS_KEY="` only matches `.env.example`.
- [ ] 10.3 Big-screen check: personality friendly, no console errors, hard refresh works.

---

## Parallel plan (subagents)

- Group 1: Phase 1 (frontend) ∥ 2.1–2.2 (`character.json`, `agent.py`) ∥ 3.1 (`speech.py`). Then 2.3–2.4 serial (`main.py`, `app.js`).
- Group 2: 7.1 (`agent.py`) ∥ 8.1 (`stt.py`) ∥ 8.3 (`mic-worklet.js`). Then 8.2, 8.4 serial.
- Everything touching `main.py` or `app.js` is serial.

---

## Risks and open questions

- Avatar has **no blink morph** (`Blink`, `Blink_L/R` have 0 binds) and no eye bones: blink is invisible with CoolPineapple.
- `relaxed` maps to VRM0 `Fun` = 37% of the happy morph: subtle. `neutral` has no binds (fine, all zero).
- Mouth (`a/i/u/e/o`) and emotion morphs share one mesh: happy + open mouth may look odd; tune weights.
- No `listening` animation exists: plan uses `idle` + mic indicator.
- 2-hour event: ~40 tasks only fit with parallel work; bonuses may be cut.
- `.env` currently sits in the parent folder, which is its own git repo with no `.gitignore` and the project untracked inside it: risk of committing the key there.
- Event key only allows Nova Lite, Polly, Transcribe in us-east-1: no STS/other calls in code.
- On the Linux server uvicorn may need `--loop asyncio` for Transcribe; we don't control the `deploy` command (mic is off there anyway).
- Nova Lite may return invalid structured output: fallback to neutral/none.
