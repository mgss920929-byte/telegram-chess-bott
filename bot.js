/*
telegram-chess-puzzle-bot - bot.js (CommonJS)
Final version with all sequential puzzle logic, user commands, admin commands,
and corrected Telegram inline keyboard formatting.

*** FINAL FIX: Puzzle Anonymity implemented. Correct answers no longer show the chosen option (move text) in the public chat announcement. ***
*** NEW FEATURE: Optional Hint button added. ***
*/

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');
const { Chess } = require('chess.js'); // Import chess.js library
const fetch = require('node-fetch'); // Import node-fetch for API calls

// Scoring Constants
const SCORE_CORRECT = 8;
const SCORE_WRONG = -16;
const STREAK_BONUS_MULTIPLIER = 0.2; // Constant for streak bonus per correct streak point
const BATTLE_PUZZLE_COUNT = 5; // Number of puzzles in a battle

// NEW: Store active battle state in memory (not persisted)
let activeBattles = {}; 

// UPDATED: Player Titles based on Score Thresholds with enhanced emojis
const PLAYER_TITLES = [
    // --- LEGENDARY RANKS ---
    { score: 3500, title: '🌌 Cosmic Grandmaster' },
    { score: 3000, title: '👑 Immortal God-King' },
    { score: 2500, title: '🔥 Alpha Zero Engine' },
    // --- MASTER RANKS ---
    { score: 2000, title: '💎 World Champion' },
    { score: 1800, title: '⚡ International Master' },
    { score: 1500, title: '🥇 FIDE Master' },
    // --- EXPERT RANKS ---
    { score: 1200, title: '⚔️ Elite Tactics Expert' },
    { score: 800, title: '🛡️ Grand Strategist' },
    // --- COMPETITIVE RANKS ---
    { score: 400, title: '💡 Puzzle Specialist' },
    { score: 200, title: '🏰 Rook Roller' },
    { score: 100, title: '♟️ Pawn Pusher' },
    { score: 50, title: 'Pusher' },
];

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// load or init data
let data = {
  // Puzzles now store options as an array of objects: [{text: 'Qd3', isAnswer: true}, ...], also tracks puzzleNumber
  puzzles: {},       
  users: {},         // userId -> { userId, name, correct:0, attempts:0, score:0, answers: {puzzleId: moveText}, lastPuzzleId: id, currentStreak:0, maxStreak:0 } 
  groups: {},        // chatId -> { chatId, title, registeredAt, score:0, attempts:0, nextPuzzleIndex: 0, battleNextPuzzleIndex: 0 } 
  settings: { globalBroadcast: [] } // array of group chatIds
};

function loadData(){
  let changed = false;
  try{
    if (fs.existsSync(DATA_FILE)){
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      
      // --- Data Migration / Initialization ---
      for (const uid in data.users) {
        if (data.users[uid] && data.users[uid].score === undefined) { data.users[uid].score = 0; changed = true; }
        if (data.users[uid] && data.users[uid].lastPuzzleId === undefined) { data.users[uid].lastPuzzleId = null; changed = true; }
        if (data.users[uid] && data.users[uid].currentStreak === undefined) { data.users[uid].currentStreak = 0; changed = true; }
        if (data.users[uid] && data.users[uid].maxStreak === undefined) { data.users[uid].maxStreak = 0; changed = true; }
      }
      for (const cid in data.groups) {
        if (data.groups[cid] && data.groups[cid].score === undefined) { data.groups[cid].score = 0; changed = true; }
        if (data.groups[cid] && data.groups[cid].attempts === undefined) { data.groups[cid].attempts = 0; changed = true; }
        // NEW: Initialize group puzzle rotation index
        if (data.groups[cid] && data.groups[cid].nextPuzzleIndex === undefined) { data.groups[cid].nextPuzzleIndex = 0; changed = true; }
        // NEW: Initialize battle rotation index
        if (data.groups[cid] && data.groups[cid].battleNextPuzzleIndex === undefined) { data.groups[cid].battleNextPuzzleIndex = 0; changed = true; }
      }
      
      // --- PERMANENT FIX: DEEP DATA CLEANUP AND MIGRATION ---
      const cleanPuzzles = {};
      let removedCount = 0;

      for (const pid in data.puzzles) {
          const p = data.puzzles[pid];

          // 1. CRITICAL CHECK: Remove invalid/incomplete puzzles entirely. 
          if (!p || !p.photoFileId || !p.title || !p.options || p.options.length === 0) {
              removedCount++;
              changed = true;
              continue; // Skip and do not include in cleanPuzzles
          }
          
          // 2. Standard Migrations/Cleanup
          if (p.answerKey && p.options.length > 0 && p.options[0].key) {
              p.options = p.options.map(opt => ({
                  text: opt.text,
                  isAnswer: opt.key === p.answerKey
              }));
              delete p.answerKey;
              changed = true;
          }
          if (p.createdByUserName === undefined) {
              p.createdByUserName = 'Admin';
              changed = true;
          }
          // Remove all expiry data permanently
          if (p.expiresAt !== undefined) {
              delete p.expiresAt;
              changed = true;
          }
          
          // NEW: Ensure 'hint' field exists (defaults to null if not present in old data)
          if (p.hint === undefined) {
              p.hint = null;
              changed = true;
          }

          // Re-indexing will be done by /reindexpuzzles, but ensure initial check passes
          if (p.puzzleNumber === undefined) {
              const keys = Object.keys(data.puzzles);
              p.puzzleNumber = keys.findIndex(k => k === pid) + 1;
              changed = true;
          }

          cleanPuzzles[pid] = p;
      }
      
      if (removedCount > 0) {
          console.warn(`⚠️ CLEANUP: Removed ${removedCount} corrupt/incomplete puzzles from data.json.`);
          data.puzzles = cleanPuzzles;
          changed = true;
      }
    }
  }catch(e){
    console.error('Failed loading data file:', e);
  }
  if (changed) {
    saveData();
  }
}
function saveData(){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
loadData();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Please set BOT_TOKEN in environment');
  process.exit(1);
}

// *** CRITICAL NETWORK FIX: FORCE IPv4 ***
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: true,
    request: {
        agentOptions: {
            keepAlive: true,
            family: 4 // FORCES IPv4 USAGE to fix EFATAL AggregateError
        }
    }
});
// *** END NETWORK FIX ***

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean).map(Number);
console.log('Bot started');

// REVISED: ADMIN_ACCESS_MESSAGE_STYLED now includes full guide in a single block
const ADMIN_ACCESS_MESSAGE_STYLED = `
╔════════════════════════════╗
║    👑 **ADMIN ACCESS & GUIDE** 👑   ║
╠════════════════════════════╣
║ To become admin:                  ║
║ 👉 **Contact:** \`@Authority_Provider\`║
╠════════════════════════════╣
║  **PUZZLE POSTING INSTRUCTIONS** ║
╠════════════════════════════╣
║ 1. Send PHOTO with a CAPTION:     ║
║                                 ║
║ 2. **Format (\`||\` are separators):** ║ \`POST|Title|A) Opt1|B) Opt2|......|answer=A|hint=Text\` ║
║                                 ║
║ 3. **Example (with optional hint):** ║
║ \`POST|find best move|A) Bxf6|B)Rxf6 |C)Qf1|D)Rxe3|answer=B|hint=Look for a tactical fork\`
╚════════════════════════════╝
`;

// Reusable constant for Admin instructions (Used in photo handler if caption is wrong)
const ADMIN_POSTING_INSTRUCTIONS = `
To create a puzzle and make it available for broadcast/posting (must be in this private chat):

1. Send a photo to me.
2. Use the following exact format for the photo caption:

    \`\`\`
    POST|title|A) option1|B) option2|C) option3|D) option4|answer=A|hint=Optional Hint Text Here
    \`\`\`

    * \`title\`: The puzzle's title.
    * \`A) ...\`, \`B) ...\`, etc.: The options.
    * \`answer=A\`: The correct option key (e.g., A, B, C, or D).
    * \`hint=...\`: **Optional.** The text that will pop up if a user clicks 'Get Hint'.
    * **NOTE: Expiry is permanently disabled.**

3. I will reply with the Puzzle ID, which you use for \`/broadcast\` or \`/postto\`.

`;


// NEW: Function to get player title based on score
function getPlayerTitle(score) {
    for (const rank of PLAYER_TITLES) {
        if (score >= rank.score) {
            return rank.title;
        }
    }
    return 'Unranked'; 
}


// Helpers
function isAdmin(userId){
  if (!userId) return false;
  return ADMIN_IDS.includes(Number(userId));
}

function userDisplayName(user){
  if (!user) return 'Unknown';
  return user.username ?
    `@${user.username}` : (user.first_name || '') + (user.last_name ? ` ${user.last_name}` : '');
}

// UPDATED: makeOptionsKeyboard now accepts puzzleHint
function makeOptionsKeyboard(options, isBattle = false, puzzleHint = null){
  const prefix = isBattle ? 'BATTL:' : 'ANS|';
  
  // Store the mapping from the temporary key (A, B, C...) to the move text
  const postedOptionsMap = {};

  // Create the keyboard structure: [[Button A], [Button B], ...]
  const inlineKeyboard = options.map((opt, index) => {
      const key = String.fromCharCode(65 + index);
      postedOptionsMap[key] = opt.text;
      // Each option is an array containing a single button object
      return [{ text: `${key}) ${opt.text}`, callback_data: `${prefix}${key}` }];
  });
  
  // Conditionally add a separate row for the hint button
  if (!isBattle && puzzleHint) {
    // New button sends the HINT| prefix along with the puzzle ID (which we'll add later in the flow)
    // For this generic function, we'll use a placeholder, the actual ID is added at posting time.
      inlineKeyboard.push([{ text: '💡 Get Hint', callback_data: 'HINT|PLACEHOLDER' }]);
  }

  // This is the object that will be passed as 'reply_markup'
  const replyMarkupObject = {
      inline_keyboard: inlineKeyboard
  };
  
  return {
    reply_markup: replyMarkupObject,
    postedOptionsMap: postedOptionsMap // Return the map for storage
  };
}

function registerUser(user){
  const uid = String(user.id);
  if (!data.users[uid]){
    data.users[uid] = { 
        userId: uid, 
        name: userDisplayName(user), 
        correct:0, 
        attempts:0, 
        score:0, 
        answers: {}, 
        lastPuzzleId: null,
        currentStreak: 0, 
        maxStreak: 0 
    };
    saveData();
  }
}

function addGroup(chat){
  const cid = String(chat.id);
  data.groups[cid] = data.groups[cid] || { 
    chatId: cid, 
    title: chat.title || chat.username || 'group', 
    username: chat.username || null, 
    registeredAt: Date.now(),
    score: 0, 
    attempts: 0,
    nextPuzzleIndex: 0, // for /puzzle command
    battleNextPuzzleIndex: 0 // for /battle command
  }; 
  saveData();
}

// Battle Helper functions (UPDATED FOR PERSISTENCE)
async function postNextBattlePuzzle(chatId) {
    const battle = activeBattles[chatId];
    if (!battle || !battle.isActive) return;

    const puzzleIndex = battle.currentPuzzleIndex;
    if (puzzleIndex >= BATTLE_PUZZLE_COUNT) {
        return endBattle(chatId);
    }
    
    const puzzleId = battle.puzzles[puzzleIndex].id;
    const p = data.puzzles[puzzleId];
    
    // --- BATTLE FIX: Final Validation before Posting ---
    if (!p || !p.photoFileId || !p.options || p.options.length === 0 || !p.options.some(opt => opt.isAnswer)) {
        console.error(`BATTLE ERROR: Puzzle ID ${puzzleId} failed validation (Missing photo/options/answer). Ending game.`);
        bot.sendMessage(chatId, `❌ Critical Battle Error: Puzzle #${puzzleIndex + 1} (ID: ${puzzleId.substring(0, 8)}...) is corrupted or missing essential data. Ending battle. Please notify admin.`);
        return endBattle(chatId);
    }
    // --- END BATTLE FIX ---

    // Dynamic shuffle for post
    const shuffledOptions = p.options.sort(() => 0.5 - Math.random());
    // *** FIX: Pass true here to ensure buttons have BATTL: prefix ***
    const { reply_markup, postedOptionsMap } = makeOptionsKeyboard(shuffledOptions, true); 
    
    // Store the options map on the current battle puzzle state
    battle.puzzles[puzzleIndex].postedOptionsMap = postedOptionsMap;

    const currentPuzzleNumber = puzzleIndex + 1;
    
    let message = `🧠 **Battle Puzzle ${currentPuzzleNumber} of ${BATTLE_PUZZLE_COUNT}** 🧠\n`;
    message += `Goal: Answer correctly first! (Scores don't count towards global rank)\n\n`;
    message += `${p.title}`;

    try {
        const sent = await bot.sendPhoto(chatId, p.photoFileId, {
            caption: message,
            reply_markup: reply_markup, // Passing the entire reply_markup object { inline_keyboard: [...] }
            parse_mode: 'Markdown'
        });
        
        // --- CALLBACK PERSISTENCE FIX ---
        // Store this message's metadata so the callback handler can find the puzzle.
        const battlePuzzle = data.puzzles[puzzleId];
        if (battlePuzzle) {
            battlePuzzle.postedIn.push({ 
                chatId: String(chatId), 
                msgId: sent.message_id, 
                postedAt: Date.now(),
                postedOptionsMap: postedOptionsMap // Store map of letter key -> move text
            });
            saveData(); // Save the update right away
        }
        // --- END CALLBACK PERSISTENCE FIX ---

        battle.messageIds.push(sent.message_id);
    } catch (e) {
        console.error(`Failed to post battle puzzle ${puzzleId}`, e);
        bot.sendMessage(chatId, "Failed to post the next puzzle. Battle ended.");
        endBattle(chatId);
    }
}

async function endBattle(chatId) {
    const battle = activeBattles[chatId];
    if (!battle || !battle.isActive) return;
    
    // Clean up the temporary postedIn entries created during the battle
    for (const puzzleState of battle.puzzles) {
        const puzzle = data.puzzles[puzzleState.id];
        if (puzzle) {
            // Find and remove all posted entries related to this battle's messages
            for (const msgId of battle.messageIds) {
                 const postedIndex = puzzle.postedIn.findIndex(pi => 
                    String(pi.chatId) === String(chatId) && pi.msgId === msgId
                );
                if (postedIndex !== -1) {
                    puzzle.postedIn.splice(postedIndex, 1);
                }
            }
        }
    }
    saveData(); 
    
    battle.isActive = false;

    const scores = Object.entries(battle.scores).map(([userId, correctCount]) => ({
        user: data.users[userId] || { name: `User ${userId}` },
        score: correctCount
    }));

    if (scores.length === 0) {
        await bot.sendMessage(chatId, "⚔️ **BATTLE CONCLUDED** ⚔️\n\nNo players participated in this battle.");
        delete activeBattles[chatId];
        return;
    }
    
    scores.sort((a, b) => b.score - a.score);
    const winnerScore = scores[0].score;
    const winners = scores.filter(s => s.score === winnerScore);
    
    // --- DRAMATIC MESSAGE GENERATION ---
    let winnerMessage = "";
    
    if (winners.length === 1) {
        const winnerName = userDisplayName(winners[0].user);
        winnerMessage = `👑 **CHAMPION: ${winnerName}** 👑\n` + 
                        `A crushing victory! They clinched the win with **${winnerScore}** brilliant answers!\n` + 
                        `The losers are honor-bound to play the next round!`;
    } else {
        const winnerNames = winners.map(w => userDisplayName(w.user)).join(', ');
        winnerMessage = `🤝 **IT'S A TIE!** 🤝\n` + 
                        `A clash of equals! ${winnerNames} tied for first place with **${winnerScore}** correct answers.\n` + 
                        `Victory is shared! Time for a rematch in the next challenge!`;
    }

    const scoreboard = scores.map((s, i) => 
        `${i + 1}. ${s.user.name} Score: ${s.score}`
    ).join('\n');
    
    await bot.sendMessage(chatId, 
        `╔═════════════════════════╗\n` +
        `║ ⚔️ **BATTLE CONCLUDED!** ⚔️\n` + 
        `╠═════════════════════════╣\n` +
        `${winnerMessage}\n\n` +
        `🏆 **FINAL SCOREBOARD** 🏆\n` +
        `\`\`\`\n${scoreboard}\n\`\`\``,
        { parse_mode: 'Markdown' }
    );
    // --- END DRAMATIC MESSAGE GENERATION ---
    
    delete activeBattles[chatId];
}
// End Battle Helper functions

// Admin: receive photo + caption POST|...
bot.on('photo', async (msg) => {
  try{
    // allow only private chat from admins to create puzzles
    if (msg.chat.type !== 'private') return; // only accept from private
    const from = msg.from;
    if (!isAdmin(from.id)) return; // ignore non-admin
    const caption = msg.caption || '';
    if (!caption.startsWith('POST|')){
      // send instructions for posting (using template literal/backticks)
      await bot.sendMessage(msg.chat.id, ADMIN_POSTING_INSTRUCTIONS);
      return;
    }

    // parse caption
    const parts = caption.split('|').map(s=>s.trim());
    
    // Filter out metadata parts (answer=, expires=, hint=)
    const metaFilter = p => !p.startsWith('answer=') && !p.startsWith('expires=') && !p.startsWith('hint=');
    const optionAndMetaParts = parts.slice(2);
    const optionsParts = optionAndMetaParts.filter(metaFilter);
    
    if (parts.length < 3) return bot.sendMessage(msg.chat.id, 'Invalid format - expected at least title and options.');
    const title = parts[1];
    
    // Parse options: store as { key: 'A', text: 'Qd3' }
    const optionsWithKeys = optionsParts.map((op, idx) => {
      // detect key like 'A) text'
      const m = op.match(/^([A-Za-z0-9])\)\s*(.*)$/);
      if (m) return { key: m[1].toUpperCase(), text: m[2].trim() };
      return { key: String.fromCharCode(65+idx), text: op };
    });
    
    const answerPart = optionAndMetaParts.find(p => p.startsWith('answer=')) || '';
    const answerKey = (answerPart.split('=')[1] || '').toUpperCase().trim() || null;
    
    // NEW: Parse the hint part
    const hintPart = optionAndMetaParts.find(p => p.startsWith('hint=')) || '';
    const hintText = (hintPart.split('=')[1] || '').trim() || null;
    
    // REMOVED: Parsing the expiresPart
    
    // choose largest photo size
    const photo = msg.photo[msg.photo.length -1];
    if (!photo) return bot.sendMessage(msg.chat.id, 'Could not find photo data.');

    // --- NEW STRUCTURE MAPPING ---
    const rawOptions = optionsWithKeys.map(opt => ({ 
        text: opt.text, 
        isAnswer: opt.key === answerKey 
    }));
    
    const puzzleId = uuidv4();
    const now = Date.now();
    
    // REMOVED: Calculating expiresAt
    
    // Capture the admin's display name for credit
    const adminName = userDisplayName(from);

    // NEW: Assign a sequential puzzle number
    const puzzleNumber = Object.keys(data.puzzles).length + 1;

    data.puzzles[puzzleId] = {
      id: puzzleId,
      title,
      puzzleNumber, // NEW FIELD
      photoFileId: photo.file_id,
      options: rawOptions, // Store options without the old 'key' letter, but with the isAnswer flag
      hint: hintText, // NEW HINT FIELD
      createdBy: from.id,
      createdByUserName: adminName, 
      createdAt: now,
      // REMOVED: expiresAt field
      postedIn: []
    };
    saveData();

    const hintPreview = hintText ? `\nHint: "${hintText}"` : '';
    const preview = `✅ Puzzle created: ${title} (Puzzle #${puzzleNumber}, Credit: ${adminName})\nID: ${puzzleId}\nOptions: ${rawOptions.map(o=>o.text).join(' / ')}\nAnswer Key: ${answerKey || 'not set'}${hintPreview}\n\nOptions will be SHUFFLED when posted. **(Expiry Disabled)**`;
    await bot.sendMessage(msg.chat.id, preview);
    // offer quick actions
    await bot.sendMessage(msg.chat.id, 'Admin actions:\n/postpreview '+puzzleId+' - preview\n/broadcast '+puzzleId+' - send to registered groups\n/postto <chatId> '+puzzleId+' - send to specific chat');
  }catch(e){
    console.error('photo handler err', e);
  }
});

// Admin command: postpreview (UPDATED for HINT)
bot.onText(/^\/postpreview\s+(\S+)/, async (msg, match) => {
  const from = msg.from;
  if (!isAdmin(from.id)) return;
  const puzzleId = match[1];
  const p = data.puzzles[puzzleId];
  if (!p) return bot.sendMessage(msg.chat.id, 'Puzzle not found');
  
  // Dynamic shuffle for preview
  const shuffledOptions = p.options.sort(() => 0.5 - Math.random());
  // PASS HINT TEXT HERE
  const { reply_markup } = makeOptionsKeyboard(shuffledOptions, false, p.hint);
  
  const puzzleNumberText = p.puzzleNumber ? `\n(Puzzle #${p.puzzleNumber})` : '';

  await bot.sendPhoto(msg.chat.id, p.photoFileId, { caption: `Preview: ${p.title}${puzzleNumberText}\nID: ${p.id}\n(Options are shuffled for preview)`, reply_markup: reply_markup });
});

// NEW ADMIN COMMAND: /showpuzzles <id> for debugging puzzle loading (No changes)
bot.onText(/^\/showpuzzles$/, (msg) => {
    const from = msg.from;
    if (!isAdmin(from.id) || msg.chat.type !== 'private') return;

    const puzzleKeys = Object.keys(data.puzzles);
    if (puzzleKeys.length === 0) {
        return bot.sendMessage(msg.chat.id, 'No puzzles found in data.json.');
    }
    
    // Sort by puzzleNumber
    const sortedPuzzles = Object.values(data.puzzles).sort((a, b) => a.puzzleNumber - b.puzzleNumber);

    const puzzleList = sortedPuzzles.map(p => {
        const id = p.id;
        const answerText = p.options.find(opt => opt.isAnswer)?.text || 'N/A';
        const hintStatus = p.hint ? ' (HINT)' : '';
        return `- #${p.puzzleNumber}: ID: ${id.substring(0, 8)}... - ${p.title} | Answer: ${answerText}${hintStatus}`;
    }).join('\n');

    bot.sendMessage(msg.chat.id, `Loaded Puzzles (${puzzleKeys.length} total, Sorted by #):\n${puzzleList}\n\nTo view raw JSON data for a specific puzzle, run: /showpuzzles <first 8 chars of ID>`);
});

bot.onText(/^\/showpuzzles\s+(\S+)/, (msg, match) => {
    const from = msg.from;
    if (!isAdmin(from.id) || msg.chat.type !== 'private') return;
    
    const partialId = match[1];
    const fullId = Object.keys(data.puzzles).find(id => id.startsWith(partialId));

    if (!fullId) {
        return bot.sendMessage(msg.chat.id, `Puzzle starting with "${partialId}" not found.`);
    }

    const p = data.puzzles[fullId];
    if (!p) return;

    // Send the raw JSON of the puzzle data
    bot.sendMessage(msg.chat.id, `Raw Puzzle Data for ${fullId.substring(0, 8)}... (Puzzle #${p.puzzleNumber}):\n\n\`\`\`json\n${JSON.stringify(p, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
});

// 🌟 NEW ADMIN COMMAND: /removepuzzle <ID> 🌟
bot.onText(/^\/removepuzzle\s+(\S+)/, (msg, match) => {
    const from = msg.from;
    if (!isAdmin(from.id) || msg.chat.type !== 'private') {
        return bot.sendMessage(msg.chat.id, 'This command is restricted to admins in a private chat.');
    }

    const partialId = match[1];
    const fullId = Object.keys(data.puzzles).find(id => id.startsWith(partialId));

    if (!fullId) {
        return bot.sendMessage(msg.chat.id, `❌ Error: Puzzle starting with "${partialId}" not found. Run /showpuzzles to check IDs.`);
    }

    const p = data.puzzles[fullId];
    if (!p) return bot.sendMessage(msg.chat.id, 'Puzzle data is corrupt. Cannot remove.');

    // 1. Delete the puzzle
    delete data.puzzles[fullId];

    // 2. Clean up user answer references
    let userCleanupCount = 0;
    for (const uid in data.users) {
        if (data.users[uid].answers[fullId]) {
            delete data.users[uid].answers[fullId];
            userCleanupCount++;
        }
        if (data.users[uid].lastPuzzleId === fullId) {
            data.users[uid].lastPuzzleId = null;
            userCleanupCount++;
        }
    }
    
    // NOTE: Group nextPuzzleIndex/battleNextPuzzleIndex cleanup is handled indirectly by /reindexpuzzles logic.

    saveData();

    bot.sendMessage(msg.chat.id, `🗑️ **Puzzle REMOVED!**
    - **Puzzle ID:** ${fullId.substring(0, 8)}...
    - **Title:** ${p.title}
    - **User references cleaned:** ${userCleanupCount}

    **⚠️ Next Step:** Please run \`/reindexpuzzles\` immediately to fix the sequential puzzle numbering!`);
});
// 🌟 END NEW ADMIN COMMAND 🌟


// TEMPORARY ADMIN COMMAND: /reindexpuzzles (No changes)
bot.onText(/^\/reindexpuzzles$/, (msg) => {
    const from = msg.from;
    if (!isAdmin(from.id) || msg.chat.type !== 'private') {
        return bot.sendMessage(msg.chat.id, 'This command is restricted to admins in a private chat.');
    }

    const oldLength = Object.keys(data.puzzles).length;
    let newPuzzleNumber = 1;
    let reindexedCount = 0;

    // Convert to array, sort by creation time (using createdAt) to maintain a logical order
    const sortedPuzzleEntries = Object.entries(data.puzzles)
        .sort(([, a], [, b]) => (a.createdAt || 0) - (b.createdAt || 0)); 

    const reindexedPuzzles = {};

    for (const [id, p] of sortedPuzzleEntries) {
        if (p.puzzleNumber !== newPuzzleNumber) {
            p.puzzleNumber = newPuzzleNumber;
            reindexedCount++;
        }
        reindexedPuzzles[id] = p;
        newPuzzleNumber++;
    }

    // Replace the old puzzles object with the re-indexed one
    data.puzzles = reindexedPuzzles;
    
    // Reset all group sequential indices to 0/1 to reflect the re-indexing
    for (const cid in data.groups) {
        const group = data.groups[cid];
        // Only reset if the current index is higher than the new total or it's not the start
        if (group.nextPuzzleIndex > 0 || group.battleNextPuzzleIndex > 0 || oldLength !== Object.keys(data.puzzles).length) {
            group.nextPuzzleIndex = 0; 
            group.battleNextPuzzleIndex = 0;
            reindexedCount++; // Count this as a re-index-related change
        }
    }
    
    saveData();

    bot.sendMessage(msg.chat.id, `✅ Puzzle data re-indexed!
Total Puzzles found: ${oldLength} -> ${Object.keys(data.puzzles).length}
Puzzles/Groups with updated sequential numbers/indices: ${reindexedCount}
Run /showpuzzles to confirm the full, sorted list.`);
});


// Admin command: postto <chatId> <puzzleId> (UPDATED for HINT)
bot.onText(/^\/postto\s+(\S+)\s+(\S+)/, async (msg, match) => {
  const from = msg.from;
  if (!isAdmin(from.id)) return;
  const chatId = match[1];
  const puzzleId = match[2];
  const p = data.puzzles[puzzleId];
  if (!p) return bot.sendMessage(msg.chat.id, 'Puzzle not found');
  
  const creatorCredit = p.createdByUserName ? ` (Credit: ${p.createdByUserName})` : '';
  const puzzleNumberText = p.puzzleNumber ? `**Puzzle #${p.puzzleNumber}**\n` : '';

  // Dynamic shuffle for post
  const shuffledOptions = p.options.sort(() => 0.5 - Math.random());
  // PASS HINT TEXT HERE
  const { reply_markup, postedOptionsMap } = makeOptionsKeyboard(shuffledOptions, false, p.hint);

  // FIX: Manually inject the puzzleId into the hint button's callback_data string
  if (p.hint && reply_markup.inline_keyboard.length > 0) {
      const hintRow = reply_markup.inline_keyboard[reply_markup.inline_keyboard.length - 1][0];
      // HINT|PLACEHOLDER becomes HINT|puzzleId
      hintRow.callback_data = `HINT|${puzzleId}`;
  }
  
  try{
    const sent = await bot.sendPhoto(chatId, p.photoFileId, { 
      caption: `${puzzleNumberText}${p.title}${creatorCredit}` , 
      reply_markup: reply_markup, // FIX: Passing the entire reply_markup object
      parse_mode: 'Markdown'
    });
    p.postedIn.push({ 
        chatId: String(chatId), 
        msgId: sent.message_id, 
        postedAt: Date.now(),
        postedOptionsMap: postedOptionsMap // Store map of letter key -> move text
    });
    saveData();
    bot.sendMessage(msg.chat.id, `Posted to ${chatId}`);
  }catch(e){
    bot.sendMessage(msg.chat.id, `Failed to post to ${chatId}: ${e.message}`);
  }
});

// Admin: broadcast <puzzleId> (UPDATED for HINT)
bot.onText(/^\/broadcast\s+(\S+)/, async (msg, match) => {
  const from = msg.from;
  if (!isAdmin(from.id)) return;
  const puzzleId = match[1];
  const p = data.puzzles[puzzleId];
  if (!p) return bot.sendMessage(msg.chat.id, 'Puzzle not found');

  const creatorCredit = p.createdByUserName ? ` (Credit: ${p.createdByUserName})` : '';
  const puzzleNumberText = p.puzzleNumber ? `**Puzzle #${p.puzzleNumber}**\n` : '';
  
  // Dynamic shuffle for broadcast
  const shuffledOptions = p.options.sort(() => 0.5 - Math.random());
  // PASS HINT TEXT HERE
  const { reply_markup, postedOptionsMap } = makeOptionsKeyboard(shuffledOptions, false, p.hint);

  // FIX: Manually inject the puzzleId into the hint button's callback_data string
  if (p.hint && reply_markup.inline_keyboard.length > 0) {
      const hintRow = reply_markup.inline_keyboard[reply_markup.inline_keyboard.length - 1].find(b => b.callback_data === 'HINT|PLACEHOLDER');
      if (hintRow) {
        hintRow.callback_data = `HINT|${puzzleId}`;
      }
  }

  const groups = Object.keys(data.groups);
  if (groups.length === 0) return bot.sendMessage(msg.chat.id, 'No registered groups to broadcast to. Ask groups to use /register in group.');

  for (const gid of groups){
    try{
      const sent = await bot.sendPhoto(gid, p.photoFileId, { 
        caption: `${puzzleNumberText}${p.title}${creatorCredit}`, 
        reply_markup: reply_markup, // FIX: Passing the entire reply_markup object
        parse_mode: 'Markdown'
      });
      p.postedIn.push({ 
          chatId: gid, 
          msgId: sent.message_id, 
          postedAt: Date.now(),
          postedOptionsMap: postedOptionsMap // Store map of letter key -> move text
      });
    }catch(e){
      console.warn('broadcast to', gid, 'failed', e.message);
    }
  }
  saveData();
  bot.sendMessage(msg.chat.id, `Broadcast complete.`);
});

// NEW ADMIN COMMAND: /adjustscore <userId> <amount> (No changes)
bot.onText(/^\/adjustscore\s+(\S+)\s+(-?\d+)/, async (msg, match) => {
    const from = msg.from;
    if (!isAdmin(from.id) || msg.chat.type !== 'private') {
        return bot.sendMessage(msg.chat.id, 'This command is restricted to admins in a private chat.');
    }
    
    const targetUserId = match[1];
    const amount = Number(match[2]);

    const targetUserRec = data.users[targetUserId];

    if (!targetUserRec) {
        return bot.sendMessage(msg.chat.id, `Error: User with ID ${targetUserId} not found in the database.`);
    }

    targetUserRec.score += amount;
    saveData();

    const newTitle = getPlayerTitle(targetUserRec.score);
    const resultMessage = `✅ Score adjusted for **${targetUserRec.name}** (ID: ${targetUserId}).
Adjustment: ${amount > 0 ? '+' : ''}${amount} points.
**New Score:** ${targetUserRec.score}
**New Title:** ${newTitle}`;

    await bot.sendMessage(msg.chat.id, resultMessage, { parse_mode: 'Markdown' });
});


// MODIFIED: /battle logic now uses sequential rotation (battleNextPuzzleIndex)
// FIX: Added optional bot username suffix to regex for group commands
bot.onText(/^\/battle(@\S+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    const chatType = msg.chat.type;

    if (chatType !== 'group' && chatType !== 'supergroup') {
        return bot.sendMessage(chatId, 'Battle mode can only be started in a Telegram group.');
    }
    
    if (activeBattles[chatId] && activeBattles[chatId].isActive) {
        return bot.sendMessage(chatId, 'A battle is already active in this group! Please wait for it to finish.');
    }
    
    addGroup(msg.chat); // Ensure group is registered to use battleNextPuzzleIndex
    const groupRec = data.groups[chatId];

    // --- Battle Puzzle Pool & Selection (Sequential Logic) ---
    // 1. Get all valid, non-corrupt puzzles, sorted by number
    const validPuzzles = Object.values(data.puzzles).filter(p => 
        p && p.id && p.photoFileId && p.options && p.options.length > 0 && p.options.some(opt => opt.isAnswer)
    ).sort((a, b) => a.puzzleNumber - b.puzzleNumber); 

    const totalPuzzles = validPuzzles.length;
    
    if (totalPuzzles < BATTLE_PUZZLE_COUNT) {
        return bot.sendMessage(chatId, `Cannot start battle. Need at least ${BATTLE_PUZZLE_COUNT} fully-defined puzzles with answers, but only ${totalPuzzles} are available. Please check puzzles with /showpuzzles.`);
    }
    
    let startIndex = groupRec.battleNextPuzzleIndex;
    
    // Wrap around if the index exceeds the total count
    if (startIndex >= totalPuzzles) {
        startIndex = 0;
    }

    // Select the next 5 puzzles sequentially
    let selectedPuzzles = [];
    // This loop ensures that even if the next index wraps around, it selects 5 consecutive puzzles.
    for (let i = 0; i < BATTLE_PUZZLE_COUNT; i++) {
        const index = (startIndex + i) % totalPuzzles;
        // Pushing only the ID and default battle state
        selectedPuzzles.push({ id: validPuzzles[index].id, answeredBy: {} }); 
    }
    
    // Update the index for the *next* battle request
    groupRec.battleNextPuzzleIndex = (startIndex + BATTLE_PUZZLE_COUNT) % totalPuzzles;
    saveData(); 

    // --- Start Battle ---
    activeBattles[chatId] = {
        chatId,
        puzzles: selectedPuzzles, // This now contains the 5 sequential puzzle IDs
        currentPuzzleIndex: 0,
        scores: {}, 
        isActive: true,
        messageIds: [] 
    };
    
    await bot.sendMessage(chatId, 
        `⚔️ **SEQUENTIAL BATTLE MODE STARTED!** ⚔️\nStarting from Puzzle #${validPuzzles[startIndex].puzzleNumber}. Answer correctly to score points.`, 
        { parse_mode: 'Markdown' }
    );
    
    postNextBattlePuzzle(chatId);
});

// MODIFIED /puzzle: EXPIRY FILTER ALREADY REMOVED (UPDATED for HINT)
// FIX: Added optional bot username suffix to regex for group commands
bot.onText(/^\/puzzle(@\S+)?\s*(\d*)$/, async (msg, match) => {
  registerUser(msg.from);
  const chatId = String(msg.chat.id);
  const uid = String(msg.from.id);
  const userRec = data.users[uid];
  // Match index 2 captures the number if present, ignoring the bot handle in index 1
  const requestedNumber = match[2] ? Number(match[2]) : null; 

  // 1. Get all available puzzles, sorted by number (Filter is correctly removed here)
  const availablePuzzles = Object.values(data.puzzles)
    .sort((a, b) => a.puzzleNumber - b.puzzleNumber); 
    
  const totalPuzzles = availablePuzzles.length;

  if (totalPuzzles === 0) {
    return bot.sendMessage(msg.chat.id, 'No puzzles are currently available. Admins: Check your puzzle count.');
  }

  let p = null;

  if (requestedNumber) {
      // --- Case 1: Specific puzzle requested (/puzzle 15) ---
      p = availablePuzzles.find(puz => puz.puzzleNumber === requestedNumber);
      
      if (!p) {
          return bot.sendMessage(msg.chat.id, `Puzzle #${requestedNumber} not found. Available puzzles are from 1 to ${totalPuzzles}.`);
      }
      
  } else {
      // --- Case 2: Next sequential puzzle requested (/puzzle) ---
      
      addGroup(msg.chat);
      const groupRec = data.groups[chatId];
      
      let puzzleIndex = groupRec.nextPuzzleIndex;
      
      if (puzzleIndex >= totalPuzzles) {
          puzzleIndex = 0; // Wrap around to the first puzzle
      }
      
      p = availablePuzzles[puzzleIndex];
      
      // Update the group's index for the *next* request
      groupRec.nextPuzzleIndex = (puzzleIndex + 1) % totalPuzzles;
      userRec.lastPuzzleId = p.id; 
      saveData(); // Save the updated index
  }
  
  if (!p) {
      // This should never be reached if logic above is correct
      return bot.sendMessage(msg.chat.id, 'Error in puzzle selection logic. Please try again or contact an admin.');
  }

  // Common Post Logic:
  
  // Check if user has already answered this puzzle and notify them 
  let captionSuffix = '';
  // *** FIX 1: HIDE PREVIOUS ANSWER IN CAPTION ***
  if (userRec.answers[p.id]) {
    captionSuffix = `\n\n⚠️ You previously attempted this puzzle.`;
  }
  // *** END FIX 1 ***
  
  // Add puzzle number and creator credit to the caption
  const creatorCredit = p.createdByUserName ? `\n(Puzzle by: ${p.createdByUserName})` : '';
  const puzzleNumberText = `**Puzzle #${p.puzzleNumber}** / ${totalPuzzles}`; // Display X/Y
  
  // Dynamic shuffle for post
  const shuffledOptions = p.options.sort(() => 0.5 - Math.random());
  // PASS HINT TEXT HERE
  const { reply_markup, postedOptionsMap } = makeOptionsKeyboard(shuffledOptions, false, p.hint);

  // FIX: Manually inject the puzzleId into the hint button's callback_data string
  if (p.hint && reply_markup.inline_keyboard.length > 0) {
      const hintRow = reply_markup.inline_keyboard[reply_markup.inline_keyboard.length - 1].find(b => b.callback_data === 'HINT|PLACEHOLDER');
      if (hintRow) {
        hintRow.callback_data = `HINT|${p.id}`;
      }
  }

  // Post it to the chat
  try {
    const sent = await bot.sendPhoto(msg.chat.id, p.photoFileId, {
      caption: `${puzzleNumberText}\n${p.title} (Requested by ${userDisplayName(msg.from)})${captionSuffix}${creatorCredit}`,
      reply_markup: reply_markup, // FIX: Passing the entire reply_markup object
      parse_mode: 'Markdown'
    });
    // Record the posting so callback_query can find it
    p.postedIn.push({ 
        chatId: chatId, 
        msgId: sent.message_id, 
        postedAt: Date.now(),
        postedOptionsMap: postedOptionsMap // Store map of letter key -> move text
    });
    saveData();
  } catch (e) {
    // ENHANCED ERROR LOGGING HERE
    console.error(`Failed to post puzzle #${p.puzzleNumber} (${p.id}) via /puzzle command to chat ${chatId}. Telegram API Error:`, e.message, e);
    bot.sendMessage(msg.chat.id, 'Sorry, I failed to post the puzzle. This usually means the photo file is corrupted or Telegram access failed. An error has been logged for the admin.');
  }
});


// Group registration commands (No changes)
// FIX: Added optional bot username suffix to regex
bot.onText(/^\/register(@\S+)?$/, (msg) => {
  // only allow in groups
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup'){
    addGroup(msg.chat);
    bot.sendMessage(msg.chat.id, 'Group registered for puzzles. Admins can later broadcast puzzles here.');
  }else{
    bot.sendMessage(msg.chat.id, 'Use this command inside a group to register the group for puzzle broadcasts.');
  }
});

// Admin list commands (No changes)
bot.onText(/^\/remgroup\s+(\S+)/, (msg, match) => {
  const from = msg.from;
  if (!isAdmin(from.id)) return;
  const chatId = match[1];
  if (data.groups[String(chatId)]){
    delete data.groups[String(chatId)];
    saveData();
    bot.sendMessage(msg.chat.id, `Removed group ${chatId}`);
  } else bot.sendMessage(msg.chat.id, `Group ${chatId} not found`);
});

bot.onText(/^\/addgroup\s+(\S+)/, (msg, match) => {
  const from = msg.from;
  if (!isAdmin(from.id)) return;
  const chatId = match[1];
  data.groups[String(chatId)] = { chatId: String(chatId), title: `manual-${chatId}`, registeredAt: Date.now(), nextPuzzleIndex: 0 };
  saveData();
  bot.sendMessage(msg.chat.id, `Added group ${chatId} to registry`);
});

bot.onText(/^\/listgroups$/, (msg) => {
  const from = msg.from;
  if (!isAdmin(from.id)) return;
  const rows = Object.values(data.groups).map(g=>`${g.chatId} - ${g.title} (Next Index: ${g.nextPuzzleIndex || 0}) (Battle Index: ${g.battleNextPuzzleIndex || 0})`);
  bot.sendMessage(msg.chat.id, 'Registered groups:\n' + (rows.length ? rows.join('\n') : '(none)'));
});

bot.onText(/^\/listpuzzles$/, (msg) => {
  const from = msg.from;
  if (!isAdmin(from.id)) return;
  
  // Sort by puzzle number for admin list
  const sortedPuzzles = Object.values(data.puzzles).sort((a, b) => a.puzzleNumber - b.puzzleNumber);

  const rows = sortedPuzzles.map(p=>`#${p.puzzleNumber} | ${p.id.substring(0, 8)}... - ${p.title} (opts: ${p.options.find(o=>o.isAnswer)?.text || 'N/A'})`);
  bot.sendMessage(msg.chat.id, 'Puzzles:\n' + (rows.length ? rows.join('\n') : '(none)'));
});


// User commands (start, help, stats, leaderboards - logic unchanged)
// FIX: Added optional bot username suffix to regex
bot.onText(/^\/start(@\S+)?/, (msg) => {
  registerUser(msg.from);
  const fromId = msg.from.id;
  
  let welcomeMessage = `Hi ${userDisplayName(msg.from)}! Send /help to see available commands.`;

  if (isAdmin(fromId) && msg.chat.type === 'private') {
    welcomeMessage = ADMIN_ACCESS_MESSAGE_STYLED + `

Your Admin Commands:
/postpreview <id>, /broadcast <id>, /addgroup <chatId>, /remgroup <chatId>, /listgroups, /listpuzzles
/showpuzzles - Displays all loaded puzzle IDs (for debugging).
/removepuzzle <id> - **NEW:** Permanently removes a puzzle by ID.
/reindexpuzzles - **FIX:** Use this if your sequential puzzles are missing or out of order.
`;
  }
  
  bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: 'Markdown' });
});

// FIX: Added optional bot username suffix to regex
bot.onText(/^\/help(@\S+)?/, (msg) => {
  const help = `Commands:\n/start - register\n/puzzle - get the next sequential puzzle\n/puzzle <number> - get a specific puzzle by its number (e.g., /puzzle 15)\n/battle - start a 5-puzzle battle match (fun mode)\n/stats - your personal score and stats\n/leaderboard - top players globally\n/groupleaderboard - top groups\n/streakleaderboard - top correct streak players\n/analyze <PGN> - Analyze a game from PGN string (e.g., /analyze 1. e4 e5...)\n\nAdmins: send photo with caption POST|... to create puzzle. Expiry is now DISABLED.`;
  bot.sendMessage(msg.chat.id, help);
});

// UPDATED COMMAND: /analyze <PGN string> uses Lichess API (No changes)
// FIX: Added optional bot username suffix to regex
bot.onText(/^\/analyze(@\S+)?\s+([\s\S]+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    // Match index 2 captures the PGN string, ignoring the bot handle in index 1
    const pgnString = match[2] ? match[2].trim() : ''; 
    const API_URL = 'https://lichess.org/api/analysis/pgn'; // Lichess PGN Analysis API

    if (!pgnString) {
        return bot.sendMessage(chatId, "Please provide the PGN string after the /analyze command.");
    }
    
    // Notify the user that the analysis is starting
    await bot.sendMessage(chatId, "⏱️ Sending game to Lichess for deep analysis... Please wait, this may take up to a minute for long games.");


    // --- Phase 2: Lichess API Call ---
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded' 
            },
            body: `pgn=${encodeURIComponent(pgnString)}`
        });

        if (!response.ok) {
            // Handle HTTP errors or rate limits
            const errorText = await response.text();
            console.error('Lichess API Error:', response.status, errorText);
            
            // If Lichess returns 400 (Bad Request), it usually means the PGN syntax is invalid.
            if (response.status === 400) {
                 return bot.sendMessage(chatId, `❌ Analysis Failed: The PGN syntax is invalid. Lichess requires proper PGN format (usually including move numbers and a result tag).`);
            }
            return bot.sendMessage(chatId, `❌ Lichess Analysis failed. HTTP Status: ${response.status}. The PGN might be too long, or the server is busy.`);
        }
        
        // Lichess API returns a JSON object containing the game analysis
        const analysisData = await response.json();
        
        // --- Phase 3: Format and Send Results ---
        
        // CRITICAL FIX: Check if deep analysis fields exist before accessing them.
        if (!analysisData.accuracy || !analysisData.summary) {
            console.error("Lichess returned minimal analysis data (likely PGN too short or invalid).", analysisData);
            return bot.sendMessage(chatId, `⚠️ **Incomplete Analysis:** Lichess could not generate the deep analysis report. 
This usually happens if the game is **too short (under 10 moves)** or if the **PGN format is missing headers** (like [Result "*"]). Please use a full PGN for better results.`);
        }
        
        const whiteAccuracy = analysisData.accuracy.white.toFixed(2);
        const blackAccuracy = analysisData.accuracy.black.toFixed(2);
        const finalResult = analysisData.game.result;

        const summary = analysisData.summary;
        
        let analysisReport = `📈 **Lichess Game Analysis Report** 📉\n`;
        analysisReport += `\n**Game:** ${analysisData.game.white.name || 'White'} vs. ${analysisData.game.black.name || 'Black'}\n`;
        analysisReport += `**Result:** ${finalResult}\n`;
        analysisReport += `---------------------------------\n`;
        analysisReport += `🎯 **Accuracy**\n`;
        analysisReport += `White: ${whiteAccuracy}%\n`;
        analysisReport += `Black: ${blackAccuracy}%\n`;
        analysisReport += `---------------------------------\n`;
        analysisReport += `⚠️ **Move Classification**\n`;
        analysisReport += `Brilliant: ${summary.brilliant.total || 0}\n`;
        analysisReport += `Great: ${summary.great.total || 0}\n`;
        analysisReport += `Excellent: ${summary.excellent.total || 0}\n`;
        analysisReport += `Good: ${summary.good.total || 0}\n`;
        analysisReport += `Inaccuracy: ${summary.inaccuracy.total || 0} 🤨\n`;
        analysisReport += `Mistake: ${summary.mistal.total || 0} 😟\n`;
        analysisReport += `Blunder: ${summary.blunder.total || 0} 💀\n`;
        analysisReport += `Missed Win: ${summary.missedWin.total || 0}\n`;
        analysisReport += `---------------------------------\n`;
        
        // Add a link to the analysis on Lichess for deeper review
        analysisReport += `Full Analysis Link: [Click Here](${analysisData.url || 'No URL provided'})`;


        await bot.sendMessage(chatId, analysisReport, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Lichess Analysis Catch Error:', error);
        await bot.sendMessage(chatId, "❌ An error occurred while processing the analysis results.");
    }
});


// User stats commands (No changes)
// FIX: Added optional bot username suffix to regex
bot.onText(/^\/stats(@\S+)?$/, (msg) => {
  registerUser(msg.from);
  const u = data.users[String(msg.from.id)];
  const title = getPlayerTitle(u.score);
  
  const text = `Your stats:
Name: ${u.name}
Title: **${title}**
Score: ${u.score}
Streak: ${u.currentStreak} (Max: ${u.maxStreak})
Correct: ${u.correct}
Attempts: ${u.attempts}
Accuracy: ${u.attempts? Math.round(100*u.correct/u.attempts)+'%':'N/A'}`;
  
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// FIX: Added optional bot username suffix to regex
bot.onText(/^\/leaderboard(@\S+)?$/, (msg) => {
  const rows = Object.values(data.users).sort((a,b)=> b.score - a.score || b.correct - a.correct).slice(0,10);
  
  const text = rows.map((u,i)=>{
    const title = getPlayerTitle(u.score);
    return `${i+1}. ${u.name} [${title}] — ${u.score} points (${u.correct}/${u.attempts})`;
  }).join('\n') || '(no players yet)';
  
  bot.sendMessage(msg.chat.id, `Global Leaderboard:\n${text}`);
});

// FIX: Added optional bot username suffix to regex
bot.onText(/^\/streakleaderboard(@\S+)?$/, async (msg) => {
  const rows = Object.values(data.users).filter(u => u.maxStreak > 0)
    .sort((a,b)=> b.maxStreak - a.maxStreak || b.currentStreak - a.currentStreak || b.score - a.score)
    .slice(0,10);
  
  const text = rows.map((u,i)=>{
    return `${i+1}. ${u.name} — Max Streak: ${u.maxStreak} (Current: ${u.currentStreak})`;
  }).join('\n') || '(no streaks recorded yet)';
  
  await bot.sendMessage(msg.chat.id, `Top Streak Leaderboard:\n${text}`);
});

// FIX: Added optional bot username suffix to regex
bot.onText(/^\/groupleaderboard(@\S+)?$/, async (msg) => {
  const rows = Object.values(data.groups).filter(g => g.attempts > 0)
    .sort((a,b)=> b.score - a.score || b.attempts - a.attempts).slice(0,10);

  function formatGroupDisplay(group) {
    if (group.username) {
        return `[${group.title}](https://t.me/${group.username}) (@${group.username})`;
    }
    return `${group.title} (ID: ${group.chatId})`;
  }

  const text = rows.map((g,i)=>`${i+1}. ${formatGroupDisplay(g)} — ${g.score} points (${g.attempts} total answers)`).join('\n') || '(no groups have answered puzzles yet)';
  
  await bot.sendMessage(msg.chat.id, `Group Leaderboard (Top 10):\n${text}`, { parse_mode: 'Markdown' });
});


// Callback for answers (UPDATED for HINT)
bot.on('callback_query', async (callbackQuery) => {
  try{
    const dataRaw = callbackQuery.data; 
    const from = callbackQuery.from; // ESSENTIAL: ensures 'from' is defined
    registerUser(from);
    
    const chatId = String(callbackQuery.message.chat.id);
    const msgId = callbackQuery.message.message_id;
    const uid = String(from.id);

    // --- HINT BUTTON LOGIC (NEW) ---
    if (dataRaw.startsWith('HINT|')) {
        const puzzleId = dataRaw.split('|')[1];
        const puzzle = data.puzzles[puzzleId];
        
        let hintText = '💡 No specific hint was provided for this puzzle.';
        
        if (puzzle && puzzle.hint) {
            hintText = `💡 HINT: ${puzzle.hint}`;
        }
        
        // This makes the text pop up only on the user's screen
        return bot.answerCallbackQuery(callbackQuery.id, { text: hintText, show_alert: true });
    }
    // --- END HINT BUTTON LOGIC ---


    // --- BATTLE MODE CHECK & SCORING FIX ---
    if (dataRaw.startsWith('BATTL:')) {
        const battle = activeBattles[chatId];
        if (!battle || !battle.isActive) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'The battle has ended or does not exist.' });
        }
        
        const puzzleIndex = battle.currentPuzzleIndex;
        const currentPuzzleState = battle.puzzles[puzzleIndex];
        const userRec = data.users[uid];

        if (!currentPuzzleState) {
             return bot.answerCallbackQuery(callbackQuery.id, { text: 'Error: Cannot find current battle puzzle state.' });
        }

        const puzzle = data.puzzles[currentPuzzleState.id];
        const chosenKey = dataRaw.split(':')[1];
        
        // Retrieve move text from the postedOptionsMap stored during post
        const chosenMoveText = currentPuzzleState.postedOptionsMap[chosenKey];
        const correctMoveText = puzzle.options.find(opt => opt.isAnswer)?.text || null;
        
        // Check if anyone has answered this specific puzzle in the battle yet
        const alreadyAnsweredInBattle = Object.keys(currentPuzzleState.answeredBy).length > 0;
        
        if (alreadyAnsweredInBattle) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Too late! Someone answered this puzzle first.' });
        }
        
        if (!correctMoveText) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Puzzle corrupted or missing answer key. Skipping.' });
        }
        
        // --- CRITICAL BATTLE FIX: Record answer only to the temporary battle state ---
        currentPuzzleState.answeredBy = { [uid]: chosenKey }; 
        // We DO NOT save to userRec.answers here, preventing score leakage and the "already answered" error.
        // --- END CRITICAL BATTLE FIX ---

        const isCorrect = chosenMoveText === correctMoveText;
        
        if (isCorrect) {
            battle.scores[uid] = (battle.scores[uid] || 0) + 1;
        }

        const who = userDisplayName(from);
        const battlePoints = isCorrect ? '+1 Battle Point' : '— No Points';
        const replyText = isCorrect ? `✅ CORRECT! (${battlePoints})` : `❌ WRONG. Correct: ${correctMoveText}.`;
        
        await bot.answerCallbackQuery(callbackQuery.id, { text: replyText });
        
        let announcement = isCorrect 
            ? `🔥 **${who} SOLVED IT!** (+1 Battle Point) Score: ${battle.scores[uid] || 0}`
            // FIX: Battle Mode (Incorrect) - Hide chosen move and correct answer
            : `💀 ${who} got it wrong.`; // Just states they were wrong.
            
        await bot.sendMessage(chatId, announcement, { parse_mode: 'Markdown' });

        // --- BATTLE ADVANCEMENT FIX: Move to next puzzle after answer ---
        battle.currentPuzzleIndex++;
        
        if (battle.currentPuzzleIndex < BATTLE_PUZZLE_COUNT) {
            // Post the next puzzle in the battle sequence
            postNextBattlePuzzle(chatId);
        } else {
            // Battle finished
            endBattle(chatId);
        }
        // --- END BATTLE ADVANCEMENT FIX ---
        
        return; // EXIT BATTLE MODE LOGIC: Crucial to stop execution here
    } 
    // --- END BATTLE MODE CHECK & SCORING FIX ---


    // --- STANDARD PUZZLE MODE (Only runs if NOT a Battle) ---
    
    if (!dataRaw.startsWith('ANS|')) return bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown action' });
    const chosenKey = dataRaw.split('|')[1];
    
    const chatType = callbackQuery.message.chat.type;
    
    // 1. Identify the puzzle and its options map
    let puzzle = null;
    let postedOptionsMap = null;
    for (const p of Object.values(data.puzzles)){
      const postedEntry = p.postedIn.find(pi => String(pi.chatId) === chatId && pi.msgId === msgId);
      if (postedEntry){
        puzzle = p; 
        postedOptionsMap = postedEntry.postedOptionsMap; // Retrieve the map used for this specific post
        break;
      }
    }
    if (!puzzle) return bot.answerCallbackQuery(callbackQuery.id, { text: 'Puzzle not found (maybe posted before restart)' });

    const userRec = data.users[uid]; 

    // 2. CHECK IF ALREADY ANSWERED BEFORE RECORDING NEW ATTEMPT (Practice logic starts here)
    const alreadyAttempted = !!userRec.answers[puzzle.id];

    // Determine correctness outside of scoring logic
    const chosenMoveText = postedOptionsMap[chosenKey];
    const correctMoveText = puzzle.options.find(opt => opt.isAnswer)?.text || null;
    const isCorrect = correctMoveText && (chosenMoveText === correctMoveText);
    
    let scoreChange = 0; 
    let practiceAttempt = false; // Flag for final message

    if (alreadyAttempted) {
        // --- PRACTICE MODE LOGIC ---
        practiceAttempt = true;
        // Scores and stats DO NOT CHANGE, regardless of correctness
        
        // Update the last answer field only if the user got it right this time (Optional, but useful for stats)
        if (isCorrect) {
            userRec.answers[puzzle.id] = chosenMoveText; 
            saveData();
        }
        // --- END PRACTICE MODE LOGIC ---
        
    } else {
        // --- FIRST ATTEMPT SCORING LOGIC ---
        
        // 3. Record the first attempt (User stats)
        userRec.attempts = (userRec.attempts || 0) + 1;
        userRec.answers[puzzle.id] = chosenMoveText; // Record the first answer, preventing future scoring

        if (correctMoveText){
            if (isCorrect) {
                userRec.correct = (userRec.correct || 0) + 1;
                scoreChange = SCORE_CORRECT; 
                
                // --- STREAK BONUS CALCULATION (ROUNDED) ---
                const streakBonus = Math.round(userRec.currentStreak * STREAK_BONUS_MULTIPLIER);
                scoreChange += streakBonus; 
                
                userRec.currentStreak = (userRec.currentStreak || 0) + 1;
                if (userRec.currentStreak > userRec.maxStreak) {
                    userRec.maxStreak = userRec.currentStreak;
                }
                
            } else {
                scoreChange = SCORE_WRONG; 
                userRec.currentStreak = 0;
            }
            userRec.score += scoreChange; 
        }

        // 4. Group Scoring (Only on FIRST attempt)
        if ((chatType === 'group' || chatType === 'supergroup') && scoreChange !== 0) {
            const groupRec = data.groups[chatId];
            
            if (groupRec) {
                if (isCorrect) {
                    // Group score includes streak bonus
                    groupRec.score = (groupRec.score || 0) + scoreChange;
                } else {
                    groupRec.score = (groupRec.score || 0) + SCORE_WRONG;
                }
                groupRec.attempts = (groupRec.attempts || 0) + 1;
            }
        }
        saveData();
        // --- END FIRST ATTEMPT SCORING LOGIC ---
    }
    
    // 5. Send final feedback
    let replyText = '';
    let announcementText = '';

    const who = userDisplayName(from);

    if (practiceAttempt) {
        // Response for subsequent attempts (No score change)
        if (isCorrect) {
            replyText = `✅ Correct! (Practice attempt, score unchanged.)`;
            announcementText = `${who} solved it again! (Practice attempt)`;
        } else {
            // FIX 3: Hide correct answer from private pop-up but give status
            replyText = `❌ Wrong. Correct move was: ${correctMoveText}. (Practice attempt, score unchanged.)`;
            announcementText = `${who} answered incorrectly. (Practice attempt)`;
        }
    } else {
        // Response for first attempt (Score changed)
        const scoreDisplay = scoreChange !== 0 ? `(+${scoreChange} points. Current Score: ${userRec.score})` : '';
        const streakMsg = isCorrect ? ` | Streak: ${userRec.currentStreak}` : ' | Streak broken!';
        const scoreBase = scoreChange > 0 ? SCORE_CORRECT : SCORE_WRONG;
        
        if (isCorrect) {
            replyText = `✅ Correct! ${scoreDisplay}${streakMsg}`;
            // FIX 4: Hide chosen move, only show score/status in public announcement
            announcementText = `${who} answered correctly — ✅ (${scoreDisplay}${streakMsg})`; 
        } else if (correctMoveText) {
            replyText = `❌ Wrong. ${scoreDisplay} | Correct: ${correctMoveText}${streakMsg}`;
            // FIX 5: Show simple incorrect status (Hides correct answer from public chat)
            announcementText = `${who} answered incorrectly — ❌ (${scoreBase}${streakMsg})`;
        } else {
            replyText = 'Answer recorded (Puzzle had no answer key).';
            announcementText = `${who} answered: Answer recorded.`;
        }
    }


    await bot.answerCallbackQuery(callbackQuery.id, { text: replyText });
    await bot.sendMessage(callbackQuery.message.chat.id, announcementText, { parse_mode: 'Markdown' });


  }catch(e){
    console.error('callback handler err', e);
  }
});

process.on('SIGINT', ()=>{
  console.log('SIGINT saving data'); saveData(); process.exit(0);
});
process.on('SIGTERM', ()=>{ console.log('SIGTERM saving data'); saveData(); process.exit(0); });

console.log('Ready — admins:', ADMIN_IDS.join(', '));