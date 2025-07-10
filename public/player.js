// player.js

// ====== Socket.IO 連線初始化 ======
const socket = io(); // 這會自動連線到提供 /socket.io/socket.io.js 的伺服器

// ====== 獲取 HTML 元素 ======
const playerNameSpan = document.querySelector('#player-hand .player-name'); // 獲取顯示玩家名稱的 span
const opponentNameSpan = document.querySelector('#opponent-hand .player-name'); // 獲取顯示對手名稱的 span

// *** 關鍵：確保 initialSetupDiv 和 gameContainerDiv 在這裡被宣告 ***
const startGameButton = document.getElementById('startGameButton');
const initialSetupDiv = document.getElementById('initial-setup');
const gameContainerDiv = document.getElementById('game-container'); 

const playerCardImages = [
    document.getElementById('player-card-1'),
    document.getElementById('player-card-2')
];
const opponentCardImages = [
    document.getElementById('opponent-card-1'),
    document.getElementById('opponent-card-2')
];

const communityCardImages = [
    document.getElementById('community-card-1'),
    document.getElementById('community-card-2'),
    document.getElementById('community-card-3'),
    document.getElementById('community-card-4'),
    document.getElementById('community-card-5')
];

const playerChipsDisplay = document.getElementById('player-chips');
const opponentChipsDisplay = document.getElementById('opponent-chips');
const potChipsDisplay = document.getElementById('pot-chips');

const bulletinDiv = document.getElementById('bulletin');
const scoreDiv = document.getElementById('score');

const playerDealerToken = document.getElementById('player-dealer-token');
const opponentDealerToken = document.getElementById('opponent-dealer-token');

// 玩家操作按鈕
const foldButton = document.getElementById('fold');
const callButton = document.getElementById('call');
const raiseButton = document.getElementById('raise');
const raiseAmountInput = document.getElementById('raise-amount');
const reconnectButton = document.getElementById('reconnect-button');

// ====== 客戶端狀態變數 ======
let localPlayerId = null; // 儲存玩家自己的 Socket ID
let localPlayerName = "你"; // 預設值，會被伺服器發送的真實名稱覆蓋
let localPlayerChips = 1000; // 初始化，用於更新按鈕狀態

// ====== UI 更新函數 ======

/**
 * 根據牌物件獲取圖片檔案名。
 * @param {Object} cardObject - 牌物件，例如 { suit: '♠', rank: 'A' } 或 { suit: 'club', rank: 2 }
 * @returns {string} 圖片檔案名，例如 'S_A.png' 或 'club02.png'
 */
function getCardImageFileName(cardObject) {
    if (!cardObject || !cardObject.suit || !cardObject.rank) {
        return 'blank.png'; // 確保傳入有效物件
    }

    const suitMap = {
        '♠': 'spade', // 黑桃
        '♥': 'heart', // 紅心
        '♦': 'diamond', // 方塊
        '♣': 'club'  // 梅花
        // 如果伺服器傳送的是英文單字：
        // 'club': 'club', 
        // 'diamond': 'diamond', 
        // 'heart': 'heart', 
        // 'spade': 'spade'
    };

    // 如果伺服器傳送的是數字或字母（例如 'A' 或 10）
    const rankMap = {
        // 如果伺服器傳送的是數字
        2: '02', 3: '03', 4: '04', 5: '05', 6: '06', 7: '07', 8: '08', 9: '09', 
        10: '10', // 十
        11: '11',  // J
        12: '12',  // Q
        13: '13',  // K
        14: '01',  // A (Ace)
        // 如果伺服器傳送的是字母
        'T': '10', // Ten
        'J': '11',  // Jack
        'Q': '12',  // Queen
        'K': '13',  // King
        'A': '01'   // Ace
    };

    // 嘗試從映射中獲取，如果沒有則使用原始值
    const mappedSuit = suitMap[cardObject.suit] || cardObject.suit;
    const mappedRank = rankMap[cardObject.rank] || cardObject.rank;

    return `${mappedSuit}${mappedRank}.jpg`;
}


/**
 * 更新手牌圖片。
 * @param {HTMLImageElement[]} imgElements - 圖片元素的陣列 (playerCardImages 或 opponentCardImages)。
 * @param {Object[]} hand - 牌的陣列 {suit, rank}。
 */
function updateHandImages(imgElements, hand) {
    imgElements.forEach((img, index) => {
        if (hand[index]) {
            img.src = `resource/${getCardImageFileName(hand[index])}`;
        } else {
            img.src = 'resource/blank.png'; // 清空或顯示空白牌
        }
    });
}

/**
 * 更新公共牌圖片。
 * @param {Object[]} communityCards - 公共牌的陣列 {suit, rank}。
 */
function updateCommunityCardImages(communityCards) {
    communityCardImages.forEach((img, index) => {
        if (communityCards[index]) {
            img.src = `resource/${getCardImageFileName(communityCards[index])}`;
        } else {
            img.src = 'resource/blank.png'; // 隱藏未發的牌
        }
    });
}

function updateChipsDisplay(playerChips, opponentChips, potChips) {
    playerChipsDisplay.textContent = `籌碼: $${playerChips}`;
    opponentChipsDisplay.textContent = `籌碼: $${opponentChips}`;
    potChipsDisplay.textContent = `彩池: $${potChips}`;
}

/**
 * 設定莊家標記。
 * @param {string} dealerId - 莊家玩家的 Socket ID。
 */
function setDealer(dealerId) {
    playerDealerToken.classList.remove('active');
    opponentDealerToken.classList.remove('active');

    if (dealerId === localPlayerId) {
        playerDealerToken.classList.add('active');
    } else {
        opponentDealerToken.classList.add('active');
    }
}

/**
 * 啟用/禁用玩家操作按鈕。
 * @param {boolean} enable - 是否啟用按鈕。
 * @param {number} amountToCall - 需要跟注的金額。
 * @param {number} playerCurrentChips - 玩家當前籌碼。
 */
function setActionButtonState(enable, amountToCall = 0, playerCurrentChips = 0) {
    foldButton.disabled = !enable;
    raiseButton.disabled = !enable;
    raiseAmountInput.disabled = !enable;

    if (enable) {
        // 更新跟注按鈕文本
        if (amountToCall <= 0) { // 可以過牌 (check)
            callButton.value = '過牌 (Check)';
            callButton.disabled = false;
        } else { // 需要跟注 (call)
            // 如果籌碼不足以跟注，只能全下
            const actualCallAmount = Math.min(amountToCall, playerCurrentChips);
            callButton.value = `跟注 (Call) $${actualCallAmount}`;
            callButton.disabled = playerCurrentChips <= 0; // 沒籌碼就不能跟注
        }

        // 加注按鈕的處理
        const minRaise = 20; // 簡化處理，最小加注額為大盲注 (20)
        let suggestedRaiseAmount = amountToCall + minRaise;
        
        // 確保建議金額不超過玩家的總籌碼
        suggestedRaiseAmount = Math.min(suggestedRaiseAmount, playerCurrentChips);
        
        // 如果玩家籌碼連跟注都不夠，那麼加注按鈕已經被 disabled 了，這裡只處理可以加注的情況
        if (playerCurrentChips > amountToCall) { // 還有籌碼可以加注
             raiseAmountInput.value = Math.max(suggestedRaiseAmount, 0); 
        } else {
             raiseAmountInput.value = 0; // 如果只能全下，則加注金額為0
        }
    } else {
        callButton.value = '跟注 (Call)'; // 恢復預設文字
        callButton.disabled = true;
        raiseAmountInput.value = "";
        raiseAmountInput.placeholder = "加注金額";
    }
}

/**
 * 清空所有牌面和籌碼顯示 (用於新局開始前)。
 */
function clearTable() {
    [...playerCardImages, ...opponentCardImages, ...communityCardImages].forEach(img => {
        img.src = 'resource/blank.png';
    });
    updateChipsDisplay(1000, 1000, 0); // 重置為初始籌碼
    playerDealerToken.classList.remove('active');
    opponentDealerToken.classList.remove('active');
    bulletinDiv.innerHTML = '';
    scoreDiv.innerHTML = '';
}


// ====== 玩家操作事件監聽器 (修改為發送 Socket 事件) ======

foldButton.addEventListener('click', () => {
    setActionButtonState(false); // 動作後禁用按鈕
    socket.emit('playerAction', { actionType: 'fold' });
    bulletinDiv.innerHTML = "您選擇了蓋牌，等待伺服器更新。";
});

callButton.addEventListener('click', () => {
    setActionButtonState(false);
    socket.emit('playerAction', { actionType: 'call' });
    bulletinDiv.innerHTML = "您選擇了跟注/過牌，等待伺服器更新。";
});

raiseButton.addEventListener('click', () => {
    const raiseAmount = parseInt(raiseAmountInput.value, 10);
    if (isNaN(raiseAmount) || raiseAmount <= 0) {
        bulletinDiv.innerHTML = "請輸入有效的加注金額。";
        // 重新啟用按鈕讓玩家修正
        // `playerChips` 和 `amountToCall` 應該來自最近一次 `gameStateUpdate`
        setActionButtonState(true, (bulletinDiv.textContent.includes('跟注') ? parseInt(bulletinDiv.textContent.match(/\$(\d+)/)[1]) : 0), localPlayerChips);
        return;
    }
    setActionButtonState(false);
    socket.emit('playerAction', { actionType: 'raise', amount: raiseAmount });
    bulletinDiv.innerHTML = `您嘗試加注 $${raiseAmount}，等待伺服器確認。`;
});

// 重連/重新排隊按鈕
reconnectButton.addEventListener('click', () => {
    location.reload(); // 刷新頁面重新連線
});

// --- 開始遊戲按鈕的事件監聽器 ---
if (startGameButton) { // 確保按鈕存在才綁定事件
    startGameButton.addEventListener('click', () => {
        let playerName = prompt("請輸入您的玩家名稱：");
        if (!playerName || playerName.trim() === '') {
            playerName = `匿名玩家${Math.floor(Math.random() * 1000)}`;
        }
        // 發送註冊事件
        socket.emit('registerPlayer', playerName);
        bulletinDiv.innerHTML = `正在註冊玩家 <b>${playerName}</b>...`;

        // 隱藏初始設置，顯示遊戲容器 (在 playerRegistered 事件中處理會更保險)
        if (initialSetupDiv) initialSetupDiv.style.display = 'none';
        // gameContainerDiv.style.display = 'block'; // 這裡先不顯示，等註冊成功
    });
}

// ====== Socket.IO 事件監聽器 (接收來自伺服器的更新) ======

socket.on('connect', () => {
    console.log('成功連接到伺服器！');
    bulletinDiv.innerHTML = '已連接到遊戲伺服器。';
    setActionButtonState(false); // 初始狀態禁用按鈕

    // 連接成功後，確保初始設置是可見的，遊戲容器是隱藏的
    if (initialSetupDiv) initialSetupDiv.style.display = 'block';
    if (gameContainerDiv) gameContainerDiv.style.display = 'none';
    
    // *** 連線成功後，立即發送註冊和加入隊列事件 ***
    // let playerName = prompt("請輸入您的玩家名稱：");
    // if (!playerName || playerName.trim() === '') {
    //     playerName = `匿名玩家${Math.floor(Math.random() * 1000)}`;
    // }
    // socket.emit('registerPlayer', playerName);
    // bulletinDiv.innerHTML = `正在註冊玩家 <b>${playerName}</b>...`;
});

socket.on('disconnect', () => {
    console.log('與伺服器斷開連接。');
    bulletinDiv.innerHTML = '與伺服器斷開連接。請嘗試重新整理頁面。';
    setActionButtonState(false); // 斷線後禁用所有操作
});

// 接收伺服器確認玩家已註冊
socket.on('playerRegistered', (data) => {
    localPlayerId = data.playerId;
    localPlayerName = data.playerName;
    playerNameSpan.textContent = localPlayerName; // 更新 UI 顯示的玩家名稱
    updateChipsDisplay(data.chips, 1000, 0); // 更新初始籌碼
    console.log(`您已註冊為 ${localPlayerName} (ID: ${localPlayerId})。`);
    bulletinDiv.innerHTML = `您已註冊為 <b>${localPlayerName}</b>。正在加入等待隊列...`;

    // 玩家註冊成功後，顯示遊戲容器，隱藏初始設置
    if (initialSetupDiv) initialSetupDiv.style.display = 'none';
    if (gameContainerDiv) gameContainerDiv.style.display = 'block';

    socket.emit('joinQueue'); // 註冊成功後，發送加入隊列事件
});

// 接收等待隊列狀態更新
socket.on('queueStatus', (data) => {
    console.log('隊列狀態:', data.message);
    bulletinDiv.innerHTML = data.message;
    if (data.inQueue) {
        setActionButtonState(false); // 等待配對時禁用按鈕
    }
});

// 接收遊戲開始事件
socket.on('gameStart', (data) => {
    console.log('遊戲開始！房間 ID:', data.roomId, '玩家:', data.players);
    // 找到對手名稱並更新 UI
    const opponentClientName = data.players.find(pName => pName !== localPlayerName);
    opponentNameSpan.textContent = opponentClientName; 
    bulletinDiv.innerHTML = `遊戲開始！您的對手是 <b>${opponentClientName}</b>。`;
    clearTable(); // 清空牌桌，準備新局
    scoreDiv.innerHTML = ''; // 清空分數顯示
    // 具體的遊戲狀態會通過 gameStateUpdate 發送
});


socket.on('gameStateUpdate', (gameState) => {
    console.log('收到遊戲狀態更新:', gameState);

    // 更新本地顯示變數和 UI
    updateHandImages(playerCardImages, gameState.playerHand);
    updateCommunityCardImages(gameState.communityCards);
    updateChipsDisplay(gameState.playerChips, gameState.opponentChips, gameState.potChips);
    setDealer(gameState.currentDealer); // 根據伺服器傳來的 Dealer ID 更新標示
    
    // 更新 localPlayerChips，用於加注按鈕的判斷
    localPlayerChips = gameState.playerChips;

    // 顯示對手手牌 (只在攤牌時顯示牌面，其他時候顯示牌背)
    if (gameState.showOpponentCards) {
        updateHandImages(opponentCardImages, gameState.opponentHand); 
    } else {
        opponentCardImages[0].src = 'resource/cardback.jpg'; // 確保顯示背面
        opponentCardImages[1].src = 'resource/cardback.jpg';
    }

    // 更新公告欄
    bulletinDiv.innerHTML = gameState.bulletinMessage;

    // 控制玩家按鈕 (根據伺服器通知輪到誰行動)
    if (gameState.currentPlayerTurn === localPlayerId) {
        setActionButtonState(true, gameState.amountToCall, gameState.playerChips); // 啟用並傳遞跟注金額和玩家籌碼
    } else {
        setActionButtonState(false);
    }

    // 更新加注金額輸入框的預設值，如果輪到自己且可以加注
    if (gameState.currentPlayerTurn === localPlayerId && !raiseButton.disabled) {
        // 最小加注增量為 20 (大盲注)
        const minRaiseIncrement = 20; 
        // 建議的加注金額 = 跟注金額 + 最小加注增量
        let currentSuggestedRaise = gameState.amountToCall + minRaiseIncrement;
        
        // 確保建議金額不超過玩家的總籌碼
        currentSuggestedRaise = Math.min(currentSuggestedRaise, gameState.playerChips);
        
        // 如果玩家籌碼連跟注都不夠，那麼加注按鈕已經被 disabled 了
        if (gameState.playerChips > gameState.amountToCall) {
             raiseAmountInput.value = Math.max(currentSuggestedRaise, 0); 
        } else {
             raiseAmountInput.value = 0; // 如果只能全下，則加注金額為0
        }
    } else {
        raiseAmountInput.value = ''; // 非玩家回合清空
    }
});


socket.on('gameEnded', (data) => {
    // 遊戲結束，顯示最終結果
    bulletinDiv.innerHTML = data.message;
    updateChipsDisplay(data.playerChips, data.opponentChips, data.potChips); // 確保最終籌碼顯示正確
    setActionButtonState(false); // 禁用所有按鈕
    // 顯示對手牌面 (如果伺服器在 gameEnded 時也發送了 opponentHand)
    if (data.opponentHand && data.opponentHand.length > 0) {
        updateHandImages(opponentCardImages, data.opponentHand); 
    }
    console.log("遊戲結束:", data.message);
});


document.addEventListener('DOMContentLoaded', () => {
    setActionButtonState(false); 
    // 初始載入時顯示初始設置，隱藏遊戲容器
    if (initialSetupDiv) initialSetupDiv.style.display = 'block';
    if (gameContainerDiv) gameContainerDiv.style.display = 'none';
    bulletinDiv.innerHTML = '正在連線到遊戲伺服器...';
});