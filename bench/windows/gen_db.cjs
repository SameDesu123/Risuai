// Used by .github/workflows/windows-perf-bench.yml. Run from the repo root after pnpm install (needs msgpackr).
// Generates a legacy-format RisuAI save (magic header + msgpack) with one "complex bot" and filler characters.
// usage: node gen_db.cjs <out.bin> <heavyMsgs> <fillerChars> <fillerMsgsPerChar>
// msgpackr 1.10 calls buf.utf8Write(str, pos, 0xffffffff); Node 24 rejects lengths past the end of the buffer
const utf8Write = Buffer.prototype.utf8Write;
Buffer.prototype.utf8Write = function (str, offset, length) {
    return utf8Write.call(this, str, offset, Math.min(length, this.length - offset));
};
const { Packr } = require('msgpackr');
const fs = require('fs');
const crypto = require('crypto');
const [,, out = 'database.bin', heavyMsgs = '300', fillerChars = '0', fillerMsgs = '0'] = process.argv;
const packr = new Packr({ useRecords: false });
const magicHeader = Uint8Array.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const sdData = [["always", "solo, 1girl"], ['negative', ''], ["|character's appearance", ''], ['current situation', ''], ["$character's pose", ''], ["$character's emotion", ''], ['current location', '']];
const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
function para(n, seed) { let s = ''; for (let i = 0; i < n; i++) s += lorem.slice((i + seed) % 40) + ' '; return s; }

function baseChar(name) {
  return {
    name, firstMessage: 'Hello.', desc: 'desc', notes: '', chats: [], chatFolders: [], chatPage: 0, emotionImages: [], bias: [],
    viewScreen: 'none', globalLore: [], chaId: crypto.randomUUID(), type: 'character', sdData: JSON.parse(JSON.stringify(sdData)),
    utilityBot: false, customscript: [], exampleMessage: '', creatorNotes: '', systemPrompt: '', postHistoryInstructions: '',
    alternateGreetings: [], tags: [], creator: '', characterVersion: '', personality: '', scenario: '', firstMsgIndex: -1,
    replaceGlobalNote: '', triggerscript: [], additionalText: '', additionalAssets: [],
  };
}

const LUA = `
function onButtonClick(id, data)
  if data == "tick" then
    local n = tonumber(getChatVar(id, "turn")) or 0
    setChatVar(id, "turn", tostring(n + 1))
    for i = 1, 30 do
      setChatVar(id, "stat" .. i, tostring(math.random(1, 100)))
    end
    setChatVar(id, "hp", tostring(math.random(1, 100)))
    setChatVar(id, "mp", tostring(math.random(1, 100)))
    reloadDisplay(id)
  end
end
function onOutput(id)
  for i = 1, 30 do setChatVar(id, "stat" .. i, tostring(math.random(1, 100))) end
  setChatVar(id, "hp", tostring(math.random(1, 100)))
end
listenEdit("editDisplay", function(id, value, meta)
  -- typical "status window" post-processing done in Lua on every displayed message
  local turn = getChatVar(id, "turn")
  return string.gsub(value, "%[TURN%]", "turn " .. turn)
end)
`;

const STATUS_OUT = `<div class="status-card">
<img class="pf" src="{{raw::portrait$1}}">
<div class="bars"><span>HP {{getvar::hp}}</span> <span>MP {{getvar::mp}}</span> <span>[TURN]</span></div>
<div class="grid">${Array.from({ length: 12 }, (_, i) => `<div class="cell" style="background-image:url({{raw::icon${i % 8}}})">{{getvar::stat${i + 1}}}</div>`).join('')}</div>
<button risu-btn="tick" class="tickbtn">Tick</button>
</div>`;

const BG = `<style>
.status-card{position:relative;margin:8px 0;padding:10px;border-radius:14px;background:linear-gradient(135deg,rgba(40,20,60,.85),rgba(10,30,60,.85));box-shadow:0 0 24px rgba(160,80,255,.45),inset 0 0 12px rgba(255,255,255,.08);backdrop-filter:blur(6px);animation:glow 2.5s ease-in-out infinite alternate}
@keyframes glow{from{box-shadow:0 0 10px rgba(160,80,255,.3)}to{box-shadow:0 0 30px rgba(80,200,255,.6)}}
.status-card .pf{width:96px;height:96px;object-fit:cover;border-radius:50%;filter:drop-shadow(0 0 6px #fff)}
.status-card .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}
.status-card .cell{height:40px;background-size:cover;border-radius:6px;color:#fff;text-shadow:0 0 4px #000;font-weight:bold}
.hud{position:fixed;right:12px;top:12px;width:220px;padding:10px;border-radius:12px;background:url({{raw::bg}}) center/cover;box-shadow:0 0 30px rgba(0,0,0,.6);backdrop-filter:blur(8px)}
</style>
<div class="hud"><img src="{{raw::portrait1}}" style="width:64px"> HP {{getvar::hp}} / MP {{getvar::mp}} / turn {{getvar::turn}}</div>`;

function heavyBot(nMsgs) {
  const c = baseChar('HeavyBot');
  const SIMPLE = process.env.SIMPLE === '1';
  const names = ['bg', 'portrait1', 'portrait2', 'portrait3', 'icon0', 'icon1', 'icon2', 'icon3', 'icon4', 'icon5', 'icon6', 'icon7'];
  c.additionalAssets = names.map((n, i) => [n, `assets/bench_img${String(i).padStart(2, '0')}.png`, 'png']);
  c.customscript = [{ comment: 'status', in: '\\[STATUS(\\d)\\]([\\s\\S]*?)\\[/STATUS\\]', out: STATUS_OUT, type: 'editdisplay', flag: 'g' }];
  c.triggerscript = [{ comment: '', type: 'start', conditions: [], effect: [{ type: 'triggerlua', code: LUA }] }];
  c.backgroundHTML = BG;
  if (process.env.LLA === '1') c.lowLevelAccess = true;
  if (SIMPLE) { c.customscript = []; c.triggerscript = []; c.backgroundHTML = ''; }
  c.firstMessage = 'Welcome. [STATUS1]start[/STATUS]';
  const msgs = [];
  for (let i = 0; i < nMsgs; i++) {
    const user = i % 2 === 0;
    msgs.push(user ? { role: 'user', data: para(2, i), chatId: crypto.randomUUID(), time: 1700000000000 + i }
                   : { role: 'char', data: para(8, i) + `\n[TURN]\n[STATUS${1 + (i % 3)}]x[/STATUS]\n` + para(4, i + 7), chatId: crypto.randomUUID(), time: 1700000000000 + i, saying: c.chaId });
  }
  const state = { $hp: '50', $mp: '50', $turn: '0' };
  for (let i = 1; i <= 30; i++) state['$stat' + i] = String(i);
  c.chats = [{ message: msgs, note: '', name: 'Chat 1', localLore: [], scriptstate: state, id: crypto.randomUUID() }];
  return c;
}

function filler(i, nMsgs) {
  const c = baseChar('Filler' + i);
  const msgs = [];
  for (let k = 0; k < nMsgs; k++) msgs.push({ role: k % 2 ? 'char' : 'user', data: para(14, k + i), chatId: crypto.randomUUID(), time: 1700000000000 + k });
  c.chats = [{ message: msgs, note: '', name: 'Chat 1', localLore: [], id: crypto.randomUUID() }];
  return c;
}

const db = { didFirstSetup: true, characters: [heavyBot(+heavyMsgs)], language: 'en',
  aiModel: 'reverse_proxy', subModel: 'reverse_proxy', forceReplaceUrl: 'http://fakellm.test:8899/v1/chat/completions',
  proxyKey: 'sk-test', customProxyRequestModel: 'fake-model', useStreaming: true, usePlainFetch: true, maxContext: 16000, maxResponse: 4000 };
for (let i = 0; i < +fillerChars; i++) db.characters.push(filler(i, +fillerMsgs));
const packed = packr.encode(db);
const buf = new Uint8Array(magicHeader.length + packed.length);
buf.set(magicHeader, 0); buf.set(packed, magicHeader.length);
fs.writeFileSync(out, buf);
console.log(out, (buf.length / 1024 / 1024).toFixed(1) + 'MB', 'chars', db.characters.length);
