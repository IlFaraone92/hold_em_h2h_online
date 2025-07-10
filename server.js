//server.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 提供靜態檔案 (HTML, CSS, JS, 圖片)
app.use(express.static(__dirname + '/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/Online_hold_em.html');
});

const MAX_PLAYERS_PER_ROOM = 2; // 定義每個房間的玩家數量

// 遊戲狀態變數
const connectedPlayers = {}; // 存儲所有連線玩家的資訊 { playerId: { name: 'playerName', socket: socketObject, chips: 1000 } }
const waitingQueue = []; // 等待配對的玩家 ID 列表
const gameRooms = {}; // 存儲所有遊戲房間的資訊 { roomId: { players: [], deck: [], communityCards: [], pot: 0, ... } }

// 撲克牌相關常數
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const INITIAL_CHIPS = 1000;
const BIG_BLIND = 20;

// ---
// ## Socket.IO 連線處理
// ---

io.on('connection', (socket) => {
    const playerId = socket.id;
    console.log('新玩家連線:', playerId);

    // 處理玩家註冊
    socket.on('registerPlayer', (playerName) => {
        if (!playerName || playerName.trim() === '') {
            playerName = `匿名玩家${Math.floor(Math.random() * 1000)}`;
        }
        connectedPlayers[playerId] = {
            id: playerId,
            name: playerName,
            socket: socket,
            chips: INITIAL_CHIPS,
            currentRoundBet: 0, // 當前輪次下注額
            folded: false,      // 是否已蓋牌
            hasActed: false,    // 當前輪次是否已行動
            isAllIn: false      // 是否已全下
        };
        console.log(`玩家 ${playerName} (${playerId}) 已註冊。`);
        socket.emit('playerRegistered', { playerId: playerId, playerName: playerName, chips: INITIAL_CHIPS });
    });

    // 處理加入隊列
    socket.on('joinQueue', () => {
        const player = connectedPlayers[playerId];
        if (!player) {
            console.warn(`玩家 ${playerId} 嘗試加入隊列但未註冊。`);
            socket.emit('error', '請先註冊您的玩家名稱。');
            return;
        }
        if (!waitingQueue.includes(playerId)) {
            waitingQueue.push(playerId);
            console.log(`玩家 ${player.name} (${playerId}) 加入等待隊列。目前隊列:`, waitingQueue.length);
            socket.emit('queueStatus', { message: '您已加入等待隊列，等待配對中...', inQueue: true });
            checkAndFormRoom();
        } else {
            socket.emit('queueStatus', { message: '您已在等待隊列中。', inQueue: true });
        }
    });

    // 處理玩家行動
    socket.on('playerAction', async ({ actionType, amount }) => {
        const player = connectedPlayers[playerId];
        if (!player) {
            console.warn(`未知的玩家 ${playerId} 嘗試行動。`);
            return;
        }

        const roomId = findPlayerRoom(playerId);
        if (!roomId) {
            console.warn(`玩家 ${player.name} 不在任何房間中。`);
            return;
        }

        const room = gameRooms[roomId];
        if (!room || room.currentTurnPlayerId !== playerId) {
            console.warn(`現在不是玩家 ${player.name} 的回合或房間不存在。`);
            socket.emit('error', '現在不是您的回合或房間不存在。');
            return;
        }

        console.log(`玩家 ${player.name} (${playerId}) 在房間 ${roomId} 執行 ${actionType}，金額: ${amount}`);
        await processPlayerAction(room, playerId, actionType, amount);
    });

    // 處理斷線
    socket.on('disconnect', () => {
        console.log('玩家斷開:', playerId);
        const disconnectedPlayerName = connectedPlayers[playerId] ? connectedPlayers[playerId].name : '未知玩家';
        delete connectedPlayers[playerId]; // 從連線玩家列表中移除

        // 從等待隊列中移除 (如果玩家在排隊中斷線)
        const indexInQueue = waitingQueue.indexOf(playerId);
        if (indexInQueue > -1) {
            waitingQueue.splice(indexInQueue, 1);
            console.log(`玩家 ${disconnectedPlayerName} 從排隊隊列中移除。`);
        }

        // 處理房間內的玩家斷線 (例如，宣告另一方獲勝)
        const roomId = findAndHandlePlayerDisconnect(playerId);
        if (roomId) {
            console.log(`玩家 ${disconnectedPlayerName} 從房間 ${roomId} 斷線，房間已清除。`);
        }
    });
});

// ---
// ## 遊戲邏輯函數
// ---

/**
 * 檢查等待隊列並嘗試組建遊戲房間。
 */
function checkAndFormRoom() {
    if (waitingQueue.length >= MAX_PLAYERS_PER_ROOM) {
        const player1Id = waitingQueue.shift();
        const player2Id = waitingQueue.shift();

        const player1 = connectedPlayers[player1Id];
        const player2 = connectedPlayers[player2Id];

        if (player1 && player2) {
            const roomId = `room-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            gameRooms[roomId] = {
                id: roomId,
                players: [player1Id, player2Id],
                playerStates: {
                    [player1Id]: { ...player1, chips: INITIAL_CHIPS, currentRoundBet: 0, folded: false, hasActed: false, isAllIn: false, hand: [] },
                    [player2Id]: { ...player2, chips: INITIAL_CHIPS, currentRoundBet: 0, folded: false, hasActed: false, isAllIn: false, hand: [] }
                },
                deck: [],
                communityCards: [],
                pot: 0,
                currentBet: 0,
                currentDealer: null, // 莊家ID
                currentTurnPlayerId: null, // 當前回合的玩家ID
                stage: 'pre-flop', // pre-flop, flop, turn, river, showdown, end-round
                lastActionMessage: '', // 上一個動作的公告訊息
                potMessage: '', // 分池訊息
                winnerId: null,
                loserId: null,
                player1BestHand: null,
                player2BestHand: null
            };

            // 讓玩家加入 Socket.IO 房間
            player1.socket.join(roomId);
            player2.socket.join(roomId);

            console.log(`房間 ${roomId} 已建立，玩家 ${player1.name} 和 ${player2.name} 加入。`);
            io.to(roomId).emit('gameStart', { roomId: roomId, players: [player1.name, player2.name] });

            // 開始第一局遊戲
            startGameRound(gameRooms[roomId]);
        } else {
            // 如果有玩家斷線，將剩餘玩家重新放回隊列
            if (player1) waitingQueue.unshift(player1Id);
            if (player2) waitingQueue.unshift(player2Id);
            console.warn('組建房間失敗，有玩家斷線。');
        }
    }
}

/**
 * 開始一個新的遊戲回合。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
function startGameRound(room) {
    // 偵錯
    // console.log(`--- Round Start for Room ${room.id} ---`);
    // console.log(`Players Initial Chips: P1(${room.playerStates[room.players[0]].name}): ${room.playerStates[room.players[0]].chips}, P2(${room.playerStates[room.players[1]].name}): ${room.playerStates[room.players[1]].chips}`);
    // console.log(`Total Chips at Round Start: ${room.playerStates[room.players[0]].chips + room.playerStates[room.players[1]].chips}`);
    // 偵錯結束
    room.deck = createAndShuffleDeck();
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.stage = 'pre-flop';
    room.winnerId = null;
    room.loserId = null; // 確保在每回合開始時重置 loserId
    room.player1BestHand = null;
    room.player2BestHand = null;
    room.potMessage = ''; // 清空上一回合的彩池訊息

    // 重置玩家狀態
    for (const playerId of room.players) {
        room.playerStates[playerId].hand = [];
        room.playerStates[playerId].currentRoundBet = 0;
        room.playerStates[playerId].folded = false;
        room.playerStates[playerId].hasActed = false;
        room.playerStates[playerId].isAllIn = false;
        room.playerStates[playerId].totalBetInHand = 0; // **關鍵：初始化本手牌的總投入**
        // 如果您有在玩家狀態中保存了初始籌碼，可以考慮在这里更新，确保计算正確
        // 例如：room.playerStates[playerId].chipsAtStartOfHand = room.playerStates[playerId].chips;
    }

    // 確定本回合的莊家 (大小盲邏輯)
    // 只有在房間剛建立（第一次 startGameRound 調用）時才隨機選一個莊家
    // 新回合的莊家切換邏輯已在 checkGameEndConditionAndProceed 中處理
    if (room.currentDealer === null) {
        room.currentDealer = room.players[Math.floor(Math.random() * room.players.length)];
    }
    
    dealHoleCards(room); // 發手牌給玩家
    distributeBlinds(room); // 分發大小盲注

    // 設置第一位行動的玩家 (Pre-flop 階段，莊家/小盲注先行動)
    room.currentTurnPlayerId = room.currentDealer;

    room.lastActionMessage = `新一局開始！[DEALER_NAME] 為莊家，[NON_DEALER_NAME] 下大盲。輪到 [CURRENT_TURN_PLAYER_NAME] 行動。`;
    updateRoomClients(room);
}

/**
 * 創建一副標準的撲克牌並洗牌。
 * @returns {Array<Object>} 洗牌後的牌組。
 */
function createAndShuffleDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rankStr of RANKS) { // 使用 rankStr 來表示原始字串牌面
            deck.push({ suit, rank: rankToNumber(rankStr) }); // 在這裡轉換為數字 rank
        }
    }
    // 洗牌 (Fisher-Yates shuffle)
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

/**
 * 向玩家發兩張手牌。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
function dealHoleCards(room) {
    for (const playerId of room.players) {
        room.playerStates[playerId].hand = [room.deck.pop(), room.deck.pop()];
    }
    console.log(`房間 ${room.id} 已發手牌。`);
}

/**
 * 分發盲注。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
function distributeBlinds(room) {
    const smallBlindAmount = BIG_BLIND / 2;

    const dealerPlayer = room.playerStates[room.currentDealer];
    const nonDealerPlayerId = room.players.find(pId => pId !== room.currentDealer);
    const nonDealerPlayer = room.playerStates[nonDealerPlayerId];

    let actualSmallBlind = Math.min(smallBlindAmount, dealerPlayer.chips);
    dealerPlayer.chips -= actualSmallBlind;
    dealerPlayer.totalBetInHand += actualSmallBlind;
    room.pot += actualSmallBlind;
    dealerPlayer.currentRoundBet += actualSmallBlind;
    if (dealerPlayer.chips === 0) dealerPlayer.isAllIn = true;

    let actualBigBlind = Math.min(BIG_BLIND, nonDealerPlayer.chips);
    nonDealerPlayer.chips -= actualBigBlind;
    nonDealerPlayer.totalBetInHand += actualBigBlind;
    room.pot += actualBigBlind;
    nonDealerPlayer.currentRoundBet += actualBigBlind;
    if (nonDealerPlayer.chips === 0) nonDealerPlayer.isAllIn = true;

    room.currentBet = Math.max(dealerPlayer.currentRoundBet, nonDealerPlayer.currentRoundBet);

    room.lastActionMessage = `[DEALER_NAME] 支付小盲 $${actualSmallBlind}，[NON_DEALER_NAME] 支付大盲 $${actualBigBlind}。`;
    // 偵錯
    // console.log(`Blinds Paid: SB $${actualSmallBlind}, BB $${actualBigBlind}`);
    // console.log(`Pot after blinds: ${room.pot}`);
    // console.log(`P1 Chips after blinds: ${room.playerStates[room.players[0]].chips}, totalBetInHand: ${room.playerStates[room.players[0]].totalBetInHand}`);
    // console.log(`P2 Chips after blinds: ${room.playerStates[room.players[1]].chips}, totalBetInHand: ${room.playerStates[room.players[1]].totalBetInHand}`);
    // console.log(`Total Chips after blinds: ${room.playerStates[room.players[0]].chips + room.playerStates[room.players[1]].chips}`);
    // 偵錯結束
}

/**
 * 發翻牌 (Flop) - 三張公共牌。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
function dealFlop(room) {
    room.deck.pop(); // 燒一張牌
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    console.log(`房間 ${room.id} 翻牌:`, room.communityCards);
}

/**
 * 發轉牌 (Turn) - 第四張公共牌。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
function dealTurn(room) {
    room.deck.pop(); // 燒一張牌
    room.communityCards.push(room.deck.pop());
    console.log(`房間 ${room.id} 轉牌:`, room.communityCards);
}

/**
 * 發河牌 (River) - 第五張公共牌。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
function dealRiver(room) {
    room.deck.pop(); // 燒一張牌
    room.communityCards.push(room.deck.pop());
    console.log(`房間 ${room.id} 河牌:`, room.communityCards);
}

/**
 * 處理玩家的行動 (Fold, Call, Raise)。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 * @param {string} playerId - 執行行動的玩家 ID。
 * @param {string} actionType - 行動類型 ('fold', 'call', 'raise')。
 * @param {number} [amount=0] - 如果是 'raise'，則為加注的金額增量。
 */
async function processPlayerAction(room, playerId, actionType, amount = 0) {
    const player = room.playerStates[playerId];
    const opponentId = room.players.find(pId => pId !== playerId);
    const opponent = room.playerStates[opponentId];

    if (player.folded || player.isAllIn || room.currentTurnPlayerId !== playerId) {
        console.warn(`玩家 ${connectedPlayers[playerId]?.name || '未知玩家'} 無法行動：已蓋牌/全下或非其回合。`);
        room.lastActionMessage = '現在不是您的行動時機。';
        updateRoomClients(room);
        return;
    }

    const amountToCall = room.currentBet - player.currentRoundBet;

    room.lastActionMessage = ''; // 重置動作訊息

    switch (actionType) {
        case 'fold':
            player.folded = true;
            room.lastActionMessage = `[CURRENT_PLAYER_NAME] 選擇了蓋牌。`;

            distributePot(room, opponent.id); // 對方直接獲勝，分池
            await checkGameEndConditionAndProceed(room); // 使用 await
            break;

        case 'call':
            let actualCallAmount = Math.min(amountToCall, player.chips);

            player.chips -= actualCallAmount;
            room.pot += actualCallAmount;
            player.currentRoundBet += actualCallAmount;
            player.totalBetInHand += actualCallAmount;
            // 偵錯
            // console.log(`${player.name} (${actionType}) - amount: ${actualCallAmount}`);
            // console.log(`  Player Chips: ${player.chips}, Current Round Bet: ${player.currentRoundBet}, Total Bet In Hand: ${player.totalBetInHand}`);
            // console.log(`  Room Pot: ${room.pot}`);
            // console.log(`  Total Chips in Game (P1+P2+Pot): ${player.chips + opponent.chips + room.pot}`);
            // 偵錯結束
            if (player.chips === 0) player.isAllIn = true;

            if (amountToCall === 0) {
                room.lastActionMessage = `[CURRENT_PLAYER_NAME] 選擇了過牌 (Check)。`;
            } else if (player.isAllIn) { // 全下（不論是否足額跟注，只要籌碼用盡就是全下）
                room.lastActionMessage = `[CURRENT_PLAYER_NAME] 選擇了全下 (All-in) $${actualCallAmount}。`;
                // 不需要降低 room.currentBet，因為它代表最高下注額**
            } else {
                room.lastActionMessage = `[CURRENT_PLAYER_NAME] 選擇了跟注 (Call) $${actualCallAmount}。`;
            }
            player.hasActed = true;
            await advanceBettingRound(room); // 確保這裡使用 await
            break;

        case 'raise':
            const totalBetAfterRaise = room.currentBet + amount;
            const amountToPayForRaise = totalBetAfterRaise - player.currentRoundBet;

            // 檢查籌碼是否足夠支付加注金額
            if (amountToPayForRaise > player.chips) {
                room.lastActionMessage = `籌碼不足以加注這麼多，請減少加注金額或全下。`;
                updateRoomClients(room);
                return;
            }

            const minRaiseIncrement = BIG_BLIND; // 兩人遊戲中，簡化設大盲作為最小增量

            if (amount < minRaiseIncrement && player.chips > amountToPayForRaise) { // 如果不是全下，則需要檢查最小加注額
                room.lastActionMessage = `加注金額至少要為 $${minRaiseIncrement}。`;
                updateRoomClients(room);
                return;
            }

            player.chips -= amountToPayForRaise;
            room.pot += amountToPayForRaise;
            player.currentRoundBet = totalBetAfterRaise;
            player.totalBetInHand += amountToPayForRaise;
            room.currentBet = totalBetAfterRaise;
            // 偵錯
            // console.log(`${player.name} (${actionType}) - amount: ${amountToPayForRaise}`);
            // console.log(`  Player Chips: ${player.chips}, Current Round Bet: ${player.currentRoundBet}, Total Bet In Hand: ${player.totalBetInHand}`);
            // console.log(`  Room Pot: ${room.pot}`);
            // console.log(`  Total Chips in Game (P1+P2+Pot): ${player.chips + opponent.chips + room.pot}`);
            // 偵錯結束
            if (player.chips === 0) player.isAllIn = true;

            room.lastActionMessage = `[CURRENT_PLAYER_NAME] 加注到 $${totalBetAfterRaise} (增加 $${amount})。`;
            player.hasActed = true;
            opponent.hasActed = false; // 對手需要重新行動

            await advanceBettingRound(room); // 確保這裡使用 await
            break;

        default:
            console.warn('未知玩家動作:', actionType);
            updateRoomClients(room);
            break;
    }
}

/**
 * 推進下注輪次的核心函數。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
async function advanceBettingRound(room) {
    const player1 = room.playerStates[room.players[0]];
    const player2 = room.playerStates[room.players[1]];

    let bettingRoundComplete = false;

    // 獲取所有「未蓋牌」的玩家
    const activePlayers = room.players.filter(pId => !room.playerStates[pId].folded);

    // 檢查下注輪是否結束的條件：
    // 1. 如果只剩一個玩家未蓋牌 (另一個蓋牌或已離開)
    // 2. 雙方都已行動 (或全下)，並且下注額相等
    // 3. 一方全下，另一方跟注到位
    const p1Acted = player1.hasActed || player1.isAllIn;
    const p2Acted = player2.hasActed || player2.isAllIn;

    if (activePlayers.length <= 1) {
        bettingRoundComplete = true;
    } else if (p1Acted && p2Acted) {
        // 如果雙方都已行動 (或 All-in)，則檢查下注額
        if (player1.currentRoundBet === player2.currentRoundBet) {
            // 雙方下注額相等 (包括都過牌，或都跟注到同一金額，或都 All-in 到同一金額)
            bettingRoundComplete = true;
        } else if (player1.isAllIn && player2.currentRoundBet >= room.currentBet) {
            // 玩家1 全下，玩家2 已行動且跟注到最高下注額
            bettingRoundComplete = true;
        } else if (player2.isAllIn && player1.currentRoundBet >= room.currentBet) {
            // 玩家2 全下，玩家1 已行動且跟注到最高下注額
            bettingRoundComplete = true;
        }
    }

    // 判斷是否需要**快速推進**剩餘階段 (例如，有玩家 All-in 且下注輪已結束)
    // 檢查是否有任何活躍玩家是 All-in 狀態 (即至少有一方是 All-in)
    const anyActivePlayerAllIn = activePlayers.some(pId => room.playerStates[pId].isAllIn);

    if (bettingRoundComplete && anyActivePlayerAllIn && room.stage !== 'river' && room.stage !== 'showdown' && room.stage !== 'end-round') {
        room.lastActionMessage += " (本輪已結束，且有玩家全下，遊戲將快速推進剩餘階段。)";
        updateRoomClients(room);
        await new Promise(resolve => setTimeout(resolve, 1500)); // 給客戶端一點時間顯示訊息

        // 快速發牌直到 River 階段
        while (room.stage !== 'river' && room.stage !== 'showdown') {
            await new Promise(resolve => setTimeout(resolve, 800)); // 每次發牌間隔
            if (room.stage === 'pre-flop') {
                dealFlop(room);
                room.stage = 'flop';
                room.lastActionMessage += " 翻牌圈 (Flop) 已發。";
            } else if (room.stage === 'flop') {
                dealTurn(room);
                room.stage = 'turn';
                room.lastActionMessage += " 轉牌圈 (Turn) 已發。";
            } else if (room.stage === 'turn') {
                dealRiver(room);
                room.stage = 'river';
                room.lastActionMessage += " 河牌圈 (River) 已發。";
            }
            updateRoomClients(room);
        }
        room.stage = 'showdown'; // 快速推進後直接進入攤牌
        await handleShowdown(room); // 快速推進後直接進入攤牌，並確保 await**
        return; // 快速推進後直接返回，不執行後續的常規回合推進邏輯**
    }

    // 常規下注輪推進邏輯 (僅在下注輪完成但沒有 All-in 快速推進時執行)
    if (bettingRoundComplete) {
        // 重置本輪下注狀態
        player1.hasActed = false;
        player2.hasActed = false;
        player1.currentRoundBet = 0;
        player2.currentRoundBet = 0;
        room.currentBet = 0; // 重置本輪最高下注額

        // 推進遊戲階段
        switch (room.stage) {
            case 'pre-flop':
                dealFlop(room);
                room.stage = 'flop';
                room.lastActionMessage += " 翻牌圈 (Flop) 已發。";
                break;
            case 'flop':
                dealTurn(room);
                room.stage = 'turn';
                room.lastActionMessage += " 轉牌圈 (Turn) 已發。";
                break;
            case 'turn':
                dealRiver(room);
                room.stage = 'river';
                room.lastActionMessage += " 河牌圈 (River) 已發。";
                break;
            case 'river':
                room.stage = 'showdown';
                await handleShowdown(room); // **確保這裡使用 await**
                return; // 直接進入攤牌，不設定下一輪行動者
            default:
                console.warn("未知的遊戲階段或遊戲已結束。");
                room.stage = 'end-round';
                break;
        }

        // 如果遊戲還在進行，設定下一輪的行動玩家 (Post-flop 階段，大盲先行動)
        // 只有在進入新下注輪時才設定當前行動者
        if (room.stage !== 'end-round' && room.stage !== 'showdown') {
            const dealerIndex = room.players.indexOf(room.currentDealer);
            room.currentTurnPlayerId = room.players[(dealerIndex + 1) % room.players.length];
            room.lastActionMessage += ` 輪到 [CURRENT_TURN_PLAYER_NAME] 行動。`;
        }
    } else {
        // 輪到另一個玩家行動 (如果輪次未結束)
        const otherPlayerId = room.players.find(pId => pId !== room.currentTurnPlayerId);
        room.currentTurnPlayerId = otherPlayerId;
        room.lastActionMessage += ` 輪到 [CURRENT_TURN_PLAYER_NAME] 行動。`;
    }
    updateRoomClients(room);
}

/**
 * 處理遊戲攤牌 (Showdown) 階段，比較牌型並決定贏家。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
async function handleShowdown(room) {
    const player1 = room.playerStates[room.players[0]];
    const player2 = room.playerStates[room.players[1]];

    // 如果有一方已經蓋牌，則另一方直接獲勝
    if (player1.folded) {
        room.winnerId = player2.id;
        room.loserId = player1.id; // 設置輸家
        room.lastActionMessage = `[FOLDED_PLAYER_NAME] 蓋牌，[WINNER_PLAYER_NAME] 獲勝！`;
    } else if (player2.folded) {
        room.winnerId = player1.id;
        room.loserId = player2.id; // 設置輸家
        room.lastActionMessage = `[FOLDED_PLAYER_NAME] 蓋牌，[WINNER_PLAYER_NAME] 獲勝！`;
    } else {
        // 雙方都沒蓋牌，進行攤牌比牌
        const player1BestResult = findBestHand(player1.hand, room.communityCards);
        const player2BestResult = findBestHand(player2.hand, room.communityCards);
        const comparisonResult = compareHandScores(player1BestResult.score, player2BestResult.score);
        if (comparisonResult > 0) {
            room.winnerId = player1.id;
            room.player1BestHand = player1BestResult; // 保存最佳手牌資訊以便客戶端顯示
            room.player2BestHand = player2BestResult;
            room.lastActionMessage = `[WINNER_PLAYER_NAME] 贏得了底池，牌型為 **${getHandTypeName(room.player1BestHand.score[0])}**！`;
        } else if (comparisonResult < 0) {
            room.winnerId = player2.id;
            room.player1BestHand = player1BestResult;
            room.player2BestHand = player2BestResult;
            room.lastActionMessage = `[WINNER_PLAYER_NAME] 贏得了底池，牌型為 **${getHandTypeName(room.player2BestHand.score[0])}**！`;
        } else {
            room.winnerId = 'draw';
            room.player1BestHand = player1BestResult;
            room.player2BestHand = player2BestResult;
            room.lastActionMessage = "雙方平手！";
        }
    }

    room.stage = 'showdown'; // 設定階段為攤牌
    updateRoomClients(room); // 更新客戶端顯示攤牌結果
    await new Promise(resolve => setTimeout(resolve, 2000)); // 給客戶端一點時間顯示訊息

    // 調用 distributePot 來分配籌碼和處理返還
    distributePot(room, room.winnerId);
    
    // **確保只在這裡調用一次 checkGameEndConditionAndProceed**
    await checkGameEndConditionAndProceed(room);
}

/**
 * 分配彩池給贏家或平分。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 * @param {string} winnerPlayerId - 贏家玩家的 ID，或 'draw' 表示平手。
 */
function distributePot(room, winnerPlayerId) {
    const player1 = room.playerStates[room.players[0]];
    const player2 = room.playerStates[room.players[1]];

    console.log(`--- Distribute Pot Debug for Room ${room.id} ---`);
    console.log(`Initial Pot: ${room.pot}`);
    console.log(`Player 1 (${player1.name}): Chips=${player1.chips}, totalBetInHand=${player1.totalBetInHand}`);
    console.log(`Player 2 (${player2.name}): Chips=${player2.chips}, totalBetInHand=${player2.totalBetInHand}`);
    console.log(`Winner ID: ${winnerPlayerId}`);

    let potMessageSuffix = '';

    if (winnerPlayerId === 'draw') {
        // 平手處理
        const halfPot = Math.floor(room.pot / 2);
        if (room.pot % 2 === 1) {
            // 如果底池為奇數，將多餘的 1 單位籌碼給莊家
            if (room.currentDealer === player1.id) {
                player1.chips += 1;
            } else {
                player2.chips += 1;
            }
        }
        player1.chips += halfPot;
        player2.chips += halfPot;
        potMessageSuffix = `平手，底池 $${room.pot} 平分！`;
        room.pot = 0; // 清空彩池
    } else {
        const winnerPlayer = room.playerStates[winnerPlayerId];
        const loserPlayerId = room.players.find(pId => pId !== winnerPlayerId);
        const loserPlayer = room.playerStates[loserPlayerId];

        const loserTotalBetInHand = loserPlayer.totalBetInHand;
        const winnerTotalBetInHand = winnerPlayer.totalBetInHand;

        // 計算主彩池：雙方都能投入的最低金額的兩倍
        const effectiveBetAmount = Math.min(loserTotalBetInHand, winnerTotalBetInHand);
        const mainPotAmount = effectiveBetAmount * 2;

        console.log(`Effective Bet Amount (per player for main pot): ${effectiveBetAmount}`);
        console.log(`Main Pot Amount: ${mainPotAmount}`);

        // 贏家從主彩池中獲得其應得的籌碼
        winnerPlayer.chips += mainPotAmount;
        console.log(`Winner (${winnerPlayer.name}) chips after main pot: ${winnerPlayer.chips}`);

        // 處理超額下注的返還
        let winnerExcessReturn = 0;
        let loserExcessReturn = 0;

        // 如果贏家投入超過有效下注金額，返還給贏家自己
        if (winnerTotalBetInHand > effectiveBetAmount) {
            winnerExcessReturn = winnerTotalBetInHand - effectiveBetAmount;
            winnerPlayer.chips += winnerExcessReturn;
            console.log(`Winner (${winnerPlayer.name}) excess return: ${winnerExcessReturn}. New chips: ${winnerPlayer.chips}`);
        }

        // 如果輸家投入超過有效下注金額，返還給輸家自己
        if (loserTotalBetInHand > effectiveBetAmount) {
            loserExcessReturn = loserTotalBetInHand - effectiveBetAmount;
            loserPlayer.chips += loserExcessReturn;
            console.log(`Loser (${loserPlayer.name}) excess return: ${loserExcessReturn}. New chips: ${loserPlayer.chips}`);
        }

        // 生成提示訊息
        potMessageSuffix = `[WINNER_PLAYER_NAME] 贏得了主底池 $${mainPotAmount}！`;
        if (winnerExcessReturn > 0) {
            potMessageSuffix += ` [WINNER_PLAYER_NAME] 返還超額下注 $${winnerExcessReturn}。`;
        }
        if (loserExcessReturn > 0) {
            potMessageSuffix += ` [LOSER_PLAYER_NAME] 返還超額下注 $${loserExcessReturn}。`;
        }

        room.pot = 0; // 清空彩池，因為所有籌碼都已經根據規則分配或返還
    }

    room.potMessage = potMessageSuffix;
    room.stage = 'end-round';
    updateRoomClients(room); // 更新客戶端顯示最新的籌碼數量和訊息

    console.log(`Final Pot (should be 0): ${room.pot}`);
    console.log(`Player 1 (${player1.name}) Final Chips: ${player1.chips}`);
    console.log(`Player 2 (${player2.name}) Final Chips: ${player2.chips}`);
    console.log(`Total Chips in Game (P1+P2+Pot): ${room.playerStates[room.players[0]].chips + room.playerStates[room.players[1]].chips + room.pot}`);
    console.log(`--- End Distribute Pot Debug ---`);
}

/**
 * 檢查當前遊戲房間的籌碼狀況，判斷遊戲是否真正結束。
 * 如果遊戲結束，則通知玩家並清除房間；否則，準備開始新回合。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
async function checkGameEndConditionAndProceed(room) { // 建議更名以反映其新職責
    const player1 = room.playerStates[room.players[0]];
    const player2 = room.playerStates[room.players[1]];

    let gameActuallyEnded = false; // 標誌位，用於判斷遊戲是否真正結束

    // 檢查玩家籌碼是否耗盡
    if (player1.chips <= 0 && player2.chips <= 0) {
        room.winnerId = 'draw';
        room.loserId = null; // 或者可以設定為 'both'
        room.lastActionMessage += " 雙方籌碼皆耗盡，遊戲結束。";
        gameActuallyEnded = true;
    } else if (player1.chips <= 0) {
        room.winnerId = player2.id;
        room.loserId = player1.id;
        room.lastActionMessage += ` [LOSER_PLAYER_NAME] 籌碼耗盡，[WINNER_PLAYER_NAME] 獲勝，遊戲結束！`;
        gameActuallyEnded = true;
    } else if (player2.chips <= 0) {
        room.winnerId = player1.id;
        room.loserId = player2.id;
        room.lastActionMessage += ` [LOSER_PLAYER_NAME] 籌碼耗盡，[WINNER_PLAYER_NAME] 獲勝，遊戲結束！`;
        gameActuallyEnded = true;
    }

    // --- 這裡開始是主要的邏輯調整 ---
    if (gameActuallyEnded) {
        room.stage = 'end-game'; // 設定一個明確的遊戲結束階段
        updateRoomClients(room); // 發送最終狀態給所有客戶端

        // 通知贏家/輸家/平局的邏輯保持不變
        if (room.winnerId !== 'draw' && connectedPlayers[room.winnerId] && connectedPlayers[room.winnerId].socket) {
            io.to(room.winnerId).emit('gameEnded', {
                message: getBulletinMessageForPlayer(room, room.winnerId),
                opponentHand: room.winnerId === player1.id ? room.player2BestHand?.hand || [] : room.player1BestHand?.hand || []
            });
        }
        if (room.loserId && connectedPlayers[room.loserId] && connectedPlayers[room.loserId].socket) {
            io.to(room.loserId).emit('gameEnded', {
                message: getBulletinMessageForPlayer(room, room.loserId),
                opponentHand: room.loserId === player1.id ? room.player2BestHand?.hand || [] : room.player1BestHand?.hand || []
            });
        }
        if (room.winnerId === 'draw') {
            if (connectedPlayers[player1.id] && connectedPlayers[player1.id].socket) {
                io.to(player1.id).emit('gameEnded', {
                    message: getBulletinMessageForPlayer(room, player1.id),
                    opponentHand: room.player2BestHand?.hand || []
                });
            }
            if (connectedPlayers[player2.id] && connectedPlayers[player2.id].socket) {
                io.to(player2.id).emit('gameEnded', {
                    message: getBulletinMessageForPlayer(room, player2.id),
                    opponentHand: room.player1BestHand?.hand || []
                });
            }
        }

        delete gameRooms[room.id]; // 刪除房間
        console.log(`遊戲房間 ${room.id} 因籌碼耗盡而結束並已清除。`);
        return true; // 遊戲已結束，返回 true
    } else {
        // 如果遊戲沒有真正結束 (只是單一回合結束)
        console.log(`房間 ${room.id} 回合結束，準備開始新回合...`);
        room.stage = 'end-round'; // 確保階段為 'end-round'，以便客戶端更新

        updateRoomClients(room); // 在等待新回合前，發送最後的回合結果

        // 延遲一段時間後開始新一局，讓客戶端有時間顯示上一局的結果
        await new Promise(resolve => setTimeout(resolve, 3000)); // 使用 await 讓流程線性化
        
        // 莊家切換邏輯
        const player1 = room.playerStates[room.players[0]];
        const player2 = room.playerStates[room.players[1]];
        room.currentDealer = room.currentDealer === player1.id ? player2.id : player1.id;

        console.log(`房間 ${room.id} 正在開始新回合...`);
        startGameRound(room); // 統一從這裡開始新回合
        return false; // 遊戲未結束，返回 false
    }
}

/**
 * 將牌面數字轉換為評分器可用的數字 (2-14)。
 * @param {string} rank - 牌面 ('2', '3', ..., 'A')。
 * @returns {number} 對應的數字。
 */
function rankToNumber(rank) {
    if (rank === 'T') return 10;
    if (rank === 'J') return 11;
    if (rank === 'Q') return 12;
    if (rank === 'K') return 13;
    if (rank === 'A') return 14;
    return parseInt(rank, 10);
}

/**
 * 根據牌型分數返回牌型名稱。
 * @param {number} scoreType - 牌型分數的第一個元素 (代表牌型)。
 * @returns {string} 牌型名稱。
 */
function getHandTypeName(scoreType) {
    const handTypes = [
        "高牌 (High Card)",
        "一對 (Pair)",
        "兩對 (Two Pair)",
        "三條 (Three of a Kind)",
        "順子 (Straight)",
        "同花 (Flush)",
        "葫蘆 (Full House)",
        "四條 (Four of a Kind)",
        "同花順 (Straight Flush)",
        "皇家同花順 (Royal Flush)"
    ];
    return handTypes[scoreType] || "未知牌型";
}

/**
 * 從給定的牌組中生成所有指定數量牌的組合。
 * @param {Array<Object>} cards - 包含牌物件的陣列。
 * @param {number} k - 要選取的牌的數量。
 * @returns {Array<Array<Object>>} - 所有組合的陣列。
 */
function getCombinations(cards, k) {
    const result = [];
    function backtrack(startIndex, currentCombination) {
        if (currentCombination.length === k) {
            result.push([...currentCombination]); // 將當前組合複製一份加入結果
            return;
        }
        for (let i = startIndex; i < cards.length; i++) {
            currentCombination.push(cards[i]);
            backtrack(i + 1, currentCombination);
            currentCombination.pop(); // 回溯
        }
    }
    backtrack(0, []);
    return result;
}

/**
 * 評估 5 張牌的牌型並返回一個可比較的數值陣列。
 * 數值越高，牌型越大。
 * 格式範例：[牌型代碼, 主要牌點1, 主要牌點2, Kicker1, Kicker2, ...]
 * 牌型代碼：
 * 9: Royal Flush
 * 8: Straight Flush
 * 7: Four of a Kind
 * 6: Full House
 * 5: Flush
 * 4: Straight
 * 3: Three of a Kind
 * 2: Two Pair
 * 1: One Pair
 * 0: High Card
 */
function evaluateHand(fiveCards) {
    // 1. 將牌按點數降序排序，方便判斷順子、對子等
    const sortedCards = [...fiveCards].sort((a, b) => b.rank - a.rank);
    const ranks = sortedCards.map(card => card.rank);
    const suits = sortedCards.map(card => card.suit);

    // 統計點數和花色出現次數
    const rankCounts = {};
    const suitCounts = {};
    for (const card of sortedCards) {
        rankCounts[card.rank] = (rankCounts[card.rank] || 0) + 1;
        suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
    }

    const isFlush = Object.values(suitCounts).some(count => count >= 5);

    // 檢查順子 (包括 A-5 順子)
    let isStraight = false;
    let straightHighCard = 0; // 順子最高牌的點數
    const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a); // 去重並排序的點數

    // 考慮 A-5 順子 (A,2,3,4,5) 的特殊情況
    if (uniqueRanks.includes(14) && uniqueRanks.includes(5) && uniqueRanks.includes(4) && uniqueRanks.includes(3) && uniqueRanks.includes(2)) {
        isStraight = true;
        straightHighCard = 5; // A-5 順子的最高牌是 5 (視為 5-high)
    } else {
        for (let i = 0; i <= uniqueRanks.length - 5; i++) {
            if (uniqueRanks[i] - uniqueRanks[i + 1] === 1 &&
                uniqueRanks[i + 1] - uniqueRanks[i + 2] === 1 &&
                uniqueRanks[i + 2] - uniqueRanks[i + 3] === 1 &&
                uniqueRanks[i + 3] - uniqueRanks[i + 4] === 1) {
                isStraight = true;
                straightHighCard = uniqueRanks[i];
                break;
            }
        }
    }

    // 檢查各種牌型（從大到小）

    // 皇家同花順 & 同花順
    if (isFlush && isStraight) {
        if (straightHighCard === 14) { // 10, J, Q, K, A 同花色
            return [9, 14, 0, 0, 0]; // Royal Flush
        } else {
            return [8, straightHighCard, 0, 0, 0]; // Straight Flush
        }
    }

    // 四條
    const quadsRank = Object.keys(rankCounts).find(r => rankCounts[r] === 4);
    if (quadsRank) {
        const otherRank = ranks.find(r => r != quadsRank);
        return [7, parseInt(quadsRank), otherRank || 0, 0, 0]; // Four of a Kind, with kicker
    }

    // 葫蘆
    const tripsRank = Object.keys(rankCounts).find(r => rankCounts[r] === 3);
    const pairRankForFullHouse = Object.keys(rankCounts).find(r => rankCounts[r] === 2);
    if (tripsRank && pairRankForFullHouse) {
        return [6, parseInt(tripsRank), parseInt(pairRankForFullHouse), 0, 0]; // Full House
    }

    // 同花
    if (isFlush) {
        return [5, ...ranks]; // Flush (按高牌排序)
    }

    // 順子
    if (isStraight) {
        return [4, straightHighCard, 0, 0, 0]; // Straight
    }

    // 三條
    if (tripsRank) {
        const kickers = ranks.filter(r => r != tripsRank).slice(0, 2); // 取最大的兩張踢腳牌
        return [3, parseInt(tripsRank), kickers[0] || 0, kickers[1] || 0, 0]; // Three of a Kind, with 2 kickers
    }

    // 兩對
    const pairs = Object.keys(rankCounts).filter(r => rankCounts[r] === 2).map(Number).sort((a, b) => b - a);
    if (pairs.length === 2) {
        const kicker = ranks.find(r => r !== pairs[0] && r !== pairs[1]);
        return [2, pairs[0], pairs[1], kicker || 0, 0]; // Two Pair, with kicker
    }

    // 一對
    if (pairs.length === 1) {
        const kickers = ranks.filter(r => r !== pairs[0]).slice(0, 3); // 取最大的三張踢腳牌
        return [1, pairs[0], kickers[0] || 0, kickers[1] || 0, kickers[2] || 0]; // One Pair, with 3 kickers
    }

    // 高牌
    return [0, ...ranks]; // High Card (按高牌排序)
}

/**
 * 找出 7 張牌中最佳的 5 張牌組合。
 * @param {Array<Object>} holeCards - 玩家或電腦的兩張手牌物件陣列。
 * @param {Array<Object>} communityCards - 五張公共牌物件陣列。
 * @returns {{bestCards: Array<Object>, score: Array<number>}} - 最佳牌組合和其分數。
 */
function findBestHand(holeCards, communityCards) {
    const allSevenCardObjects = [...holeCards, ...communityCards];

    let bestHand = [];
    // 初始化一個最低分數，確保任何有效牌型都會被選中
    // 這裡初始化為最低的「高牌」分數，且所有點數為 0，確保能被任何真實牌型超越
    let maxHandScore = [0, 0, 0, 0, 0, 0];

    // 2. 生成所有 5 張牌的組合 (從 7 張牌中選 5 張)
    const allFiveCardCombinations = getCombinations(allSevenCardObjects, 5);

    // 3. 評估每個組合的牌型，並找出分數最高的
    for (const combination of allFiveCardCombinations) {
        const currentScore = evaluateHand(combination);

        // 比較當前組合的分數與目前最高分數
        if (compareHandScores(currentScore, maxHandScore) > 0) {
            maxHandScore = currentScore;
            bestHand = combination;
        }
    }

    return { bestCards: bestHand, score: maxHandScore };
}

// 比較兩個手牌分數的輔助函數
function compareHandScores(score1, score2) {
    for (let i = 0; i < Math.max(score1.length, score2.length); i++) {
        // 為了穩健性，如果陣列長度不一致，缺少的元素視為 0
        const s1Val = score1[i] || 0;
        const s2Val = score2[i] || 0;

        if (s1Val > s2Val) {
            return 1; // score1 贏
        } else if (s1Val < s2Val) {
            return -1; // score2 贏
        }
    }
    return 0; // 平手
}

// ---
// ## 伺服器端輔助函數
// ---

/**
 * 根據玩家 ID 查找其所在的遊戲房間 ID。
 * @param {string} playerId - 玩家的 Socket ID。
 * @returns {string|null} 房間 ID 或 null。
 */
function findPlayerRoom(playerId) {
    for (const roomId in gameRooms) {
        if (gameRooms[roomId].players.includes(playerId)) {
            return roomId;
        }
    }
    return null;
}

/**
 * 向房間內所有客戶端廣播最新遊戲狀態。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 */
function updateRoomClients(room) {
    const player1Id = room.players[0];
    const player2Id = room.players[1];

    const player1State = room.playerStates[player1Id];
    const player2State = room.playerStates[player2Id];

    // 發送給 player1
    if (connectedPlayers[player1Id] && connectedPlayers[player1Id].socket) { // 確保玩家仍在線
        io.to(player1Id).emit('gameStateUpdate', {
            playerHand: player1State.hand,
            communityCards: room.communityCards,
            playerChips: player1State.chips,
            opponentChips: player2State.chips, // 對手的籌碼
            potChips: room.pot,
            currentBet: room.currentBet,
            currentDealer: room.currentDealer,
            currentPlayerTurn: room.currentTurnPlayerId,
            bulletinMessage: getBulletinMessageForPlayer(room, player1Id), // 根據玩家調整訊息
            showOpponentCards: room.stage === 'showdown' || room.stage === 'end-round', // 攤牌階段顯示對手牌
            opponentHand: room.stage === 'showdown' || room.stage === 'end-round' ? player2State.hand : [],
            amountToCall: room.currentBet - player1State.currentRoundBet // 計算 player1 需要跟注的金額
        });
    }

    // 發送給 player2
    if (connectedPlayers[player2Id] && connectedPlayers[player2Id].socket) { // 確保玩家仍在線
        io.to(player2Id).emit('gameStateUpdate', {
            playerHand: player2State.hand,
            communityCards: room.communityCards,
            playerChips: player2State.chips,
            opponentChips: player1State.chips, // 對手的籌碼
            potChips: room.pot,
            currentBet: room.currentBet,
            currentDealer: room.currentDealer,
            currentPlayerTurn: room.currentTurnPlayerId,
            bulletinMessage: getBulletinMessageForPlayer(room, player2Id), // 根據玩家調整訊息
            showOpponentCards: room.stage === 'showdown' || room.stage === 'end-round',
            opponentHand: room.stage === 'showdown' || room.stage === 'end-round' ? player1State.hand : [],
            amountToCall: room.currentBet - player2State.currentRoundBet // 計算 player2 需要跟注的金額
        });
    }
}

/**
 * 根據遊戲狀態和當前玩家生成不同的公告訊息。
 * @param {Object} room - 當前遊戲房間的狀態物件。
 * @param {string} playerId - 當前正在接收訊息的玩家 ID。
 * @returns {string} 要顯示的公告訊息。
 */
function getBulletinMessageForPlayer(room, playerId) {
    let message = '';
    const currentPlayerObj = connectedPlayers[playerId];
    const opponentId = room.players.find(pId => pId !== playerId);
    const opponentObj = connectedPlayers[opponentId];

    const selfPronoun = '您';
    const opponentPronoun = '對方玩家';

    // 處理攤牌或遊戲結束的特殊訊息
    if (room.stage === 'showdown' || room.stage === 'end-round' || room.winnerId !== null) {
        if (room.winnerId === playerId) {
            message += `**恭喜您獲勝！**`;
        } else if (room.winnerId === opponentId) {
            message += `**對方玩家獲勝了！**`;
        } else if (room.winnerId === 'draw') {
            message += `**您與對方玩家平手！**`;
        }

        // 處理因籌碼耗盡或斷線導致的遊戲結束訊息
        if (room.loserId) {
            if (room.loserId === playerId) {
                message += ` 您的籌碼已耗盡。`;
            } else if (room.loserId === opponentId) {
                message += ` ${connectedPlayers[room.loserId]?.name || '對方玩家'} 的籌碼已耗盡。`;
            }
        }

        // 添加牌型資訊
        let currentPlayerBestHand = room.player1BestHand;
        let opponentPlayerBestHand = room.player2BestHand;

        if (playerId === room.players[1]) {
            [currentPlayerBestHand, opponentPlayerBestHand] = [opponentPlayerBestHand, currentPlayerBestHand];
        }

        if (currentPlayerBestHand && currentPlayerBestHand.score) {
            message += ` 您的牌型: **${getHandTypeName(currentPlayerBestHand.score[0])}**。`;
        }
        if (opponentPlayerBestHand && opponentPlayerBestHand.score && (room.stage === 'showdown' || room.stage === 'end-round')) {
            message += ` 對方牌型: **${getHandTypeName(opponentPlayerBestHand.score[0])}**。`;
        }

        // 處理分池訊息 (現在從 room.potMessage 獲取)
        if (room.potMessage) {
            let potMessage = room.potMessage;
            if (room.winnerId === playerId) {
                potMessage = potMessage.replace('[WINNER_PLAYER_NAME]', selfPronoun);
            } else if (room.winnerId === opponentId) {
                potMessage = potMessage.replace('[WINNER_PLAYER_NAME]', opponentPronoun);
            }
            // Loser message replacement
            potMessage = potMessage.replace(new RegExp('\\[LOSER_PLAYER_NAME\\]', 'g'), room.loserId === playerId ? selfPronoun : opponentPronoun);

            message += ` ${potMessage}`;
        }
        return message.trim();
    }

    // 處理常規的行動訊息 (使用佔位符替換)
    let rawMessage = room.lastActionMessage;

    // 替換盲注訊息中的佔位符
    if (rawMessage.includes('[DEALER_NAME]')) {
        rawMessage = rawMessage.replace('[DEALER_NAME]', room.currentDealer === playerId ? selfPronoun : opponentPronoun);
    }
    if (rawMessage.includes('[NON_DEALER_NAME]')) {
        rawMessage = rawMessage.replace('[NON_DEALER_NAME]', room.players.find(pId => pId !== room.currentDealer) === playerId ? selfPronoun : opponentPronoun);
    }

    // 替換玩家行動中的佔位符
    if (rawMessage.includes('[CURRENT_PLAYER_NAME]')) {
        // 上一個行動的玩家 ID 通常是除了當前輪到行動的玩家之外的另一個玩家 (在兩人遊戲中)
        const lastActionPlayerId = room.players.find(pId => pId !== room.currentTurnPlayerId);
        if (lastActionPlayerId === playerId) {
            rawMessage = rawMessage.replace(new RegExp('\\[CURRENT_PLAYER_NAME\\]', 'g'), selfPronoun);
        } else {
            rawMessage = rawMessage.replace(new RegExp('\\[CURRENT_PLAYER_NAME\\]', 'g'), opponentPronoun);
        }
    }

    // 替換遊戲階段推進後的輪到誰行動訊息
    if (rawMessage.includes('[CURRENT_TURN_PLAYER_NAME]')) {
        rawMessage = rawMessage.replace(new RegExp('\\[CURRENT_TURN_PLAYER_NAME\\]', 'g'), room.currentTurnPlayerId === playerId ? selfPronoun : opponentPronoun);
    }

    // 處理蓋牌、勝負等明確身份的佔位符
    if (rawMessage.includes('[FOLDED_PLAYER_NAME]')) {
        if (room.loserId === playerId) {
             rawMessage = rawMessage.replace('[FOLDED_PLAYER_NAME]', selfPronoun);
        } else if (room.loserId === opponentId) {
             rawMessage = rawMessage.replace('[FOLDED_PLAYER_NAME]', opponentPronoun);
        } else {
            // 如果不是因為蓋牌導致遊戲結束，或者只是單純的行動訊息
            // 且 currentTurnPlayerId 不等於 playerId，則表示對手蓋牌
            const lastActionPlayerId = room.players.find(pId => pId !== room.currentTurnPlayerId); // 執行了上一個動作的玩家
            if (connectedPlayers[lastActionPlayerId]?.playerStates[lastActionPlayerId]?.folded) {
                rawMessage = rawMessage.replace('[FOLDED_PLAYER_NAME]', lastActionPlayerId === playerId ? selfPronoun : opponentPronoun);
            }
        }
    }
    
    if (rawMessage.includes('[WINNER_PLAYER_NAME]')) {
        rawMessage = rawMessage.replace(new RegExp('\\[WINNER_PLAYER_NAME\\]', 'g'), room.winnerId === playerId ? selfPronoun : opponentPronoun);
    }
    if (rawMessage.includes('[LOSER_PLAYER_NAME]')) {
        rawMessage = rawMessage.replace(new RegExp('\\[LOSER_PLAYER_NAME\\]', 'g'), room.loserId === playerId ? selfPronoun : opponentPronoun);
    }


    message += rawMessage; // 將處理好的 rawMessage 附加到最終訊息

    // 根據當前輪到的玩家添加行動提示
    // 只有在遊戲未結束且未進入攤牌/回合結束階段時顯示行動提示
    if (room.currentTurnPlayerId && room.stage !== 'showdown' && room.stage !== 'end-round' && room.stage !== 'end-game') {
        if (room.currentTurnPlayerId === playerId) {
            // 檢查玩家是否已經全下，如果全下則不能再行動
            if (room.playerStates[playerId].isAllIn) {
                message += ` 您已全下，等待回合結束。`;
            } else if (room.currentBet === 0 || room.currentBet === currentPlayerObj.currentRoundBet) {
                // 如果沒有人下注，或者自己的下注額與最高下注額相等 (表示可以 Check)
                message += ` 輪到**您**行動！可以過牌或加注。`;
            } else {
                const amountToCall = room.currentBet - currentPlayerObj.currentRoundBet;
                if (currentPlayerObj.chips >= amountToCall) {
                    message += ` 輪到**您**行動！請跟注 **$${amountToCall}**、加注或蓋牌。`;
                } else {
                    message += ` 輪到**您**行動！您籌碼不足，可全下 **$${currentPlayerObj.chips}** 或蓋牌。`;
                }
            }
        } else {
            message += ` 等待**對方玩家**行動...`;
        }
    } else if (room.stage === 'end-round' && room.winnerId === null) { // 回合結束但遊戲未真正結束
        message += ' 本回合結束，準備開始新一局。';
    } else if (room.stage === 'end-game') { // 遊戲真正結束
        // 訊息已經在上面處理，這裡可以留空或添加額外提示
    }
     else {
        // 其他情況，例如等待配對，或遊戲剛開始但還未輪到行動
        // 可以根據實際情況細化這個分支
        message += ' 遊戲正在進行中...';
    }


    return message.trim();
}

/**
 * 處理玩家斷線，判斷勝負並清除房間。
 * @param {string} disconnectedPlayerId - 斷線玩家的 Socket ID。
 * @returns {string|null} 如果找到並處理了房間，則返回房間 ID，否則返回 null。
 */
function findAndHandlePlayerDisconnect(disconnectedPlayerId) {
    for (const roomId in gameRooms) {
        const room = gameRooms[roomId];
        if (room.players.includes(disconnectedPlayerId)) {
            const otherPlayerId = room.players.find(id => id !== disconnectedPlayerId);

            // 通知房間內另一個玩家對方已斷線，遊戲結束，您獲勝
            if (otherPlayerId && connectedPlayers[otherPlayerId] && connectedPlayers[otherPlayerId].socket) {
                room.winnerId = otherPlayerId;
                room.loserId = disconnectedPlayerId;
                room.lastActionMessage = `[LOSER_PLAYER_NAME] 已斷線，[WINNER_PLAYER_NAME] 獲勝！`;

                // **直接設定 stage 為 'end-game'**
                room.stage = 'end-game'; 
                updateRoomClients(room); // 發送最終更新

                io.to(otherPlayerId).emit('gameEnded', {
                    message: getBulletinMessageForPlayer(room, otherPlayerId),
                    opponentHand: [] // 斷線情況下不顯示對手牌，或者可以根據需要顯示
                });
            }
            delete gameRooms[roomId]; // 從房間列表中移除此房間
            return roomId;
        }
    }
    return null;
}

// ---
// ## 啟動伺服器
// ---

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`伺服器正在 http://localhost:${PORT} 運行`);
});