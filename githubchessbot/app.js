// app.js — Patricia-backed frontend (no Web Workers)

class PatriciaClient {
  constructor() {
    this.isThinking = false;
    this.defaultMoveTimeMs = 1200;
  }

  async setPosition(fen) {
    const res = await fetch('/engine/position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen })
    });
    const data = await res.json().catch(() => ({}));
    return data && data.ok === true;
  }

  async go(options = {}) {
    // options: { movetime } or { depth } etc.
    const payload = {};
    if (options.movetime) payload.movetime = options.movetime;
    if (options.depth) payload.depth = options.depth;

    const res = await fetch('/engine/go', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    // Expected shape: { ok: true, bestmove: "e2e4", info: [...] }
    return data;
  }

  async getBestMove(fen, moveNumber, remainingMoves) {
    if (this.isThinking) return null;
    this.isThinking = true;

    const movetime = this.computeTime(remainingMoves);

    const posOK = await this.setPosition(fen);
    if (!posOK) {
      console.warn('Failed to set position on engine');
      this.isThinking = false;
      return null;
    }

    const result = await this.go({ movetime });
    this.isThinking = false;

    if (result && result.ok && result.bestmove && result.bestmove !== '(none)') {
      return result.bestmove;
    }
    return null;
  }

  computeTime(remainingMoves) {
    const base = this.defaultMoveTimeMs;
    if (remainingMoves > 4) return Math.round(base * 1.3);
    if (remainingMoves > 2) return base;
    return Math.round(base * 0.8);
  }
}

class ChessGame {
  constructor() {
    this.phases = [
      'Image Upload & FEN Extraction',
      'Board Position Setup & Editing',
      'Game Configuration',
      'Gameplay vs Patricia',
      'Results & Analysis'
    ];
    this.currentPhase = 0;

    this.board = this.createEmptyBoard();
    this.currentFEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    this.isFlipped = false;
    this.dragSource = null;

    this.firstMove = 'white';
    this.playerSide = 'white';
    this.currentPlayer = 'white';
    this.maxMoves = 6;
    this.moveCount = { white: 0, black: 0 };
    this.gameActive = false;

    this.scores = { white: 0, black: 0 };
    this.moveHistory = [];
    this.gameResult = null;

    this.pieceValues = {
      p: 1, r: 5, n: 3, b: 3, q: 9, k: 0,
      P: 1, R: 5, N: 3, B: 3, Q: 9, K: 0
    };

    this.pieceSymbols = {
      K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
      k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'
    };

    this.castlingRights = { K: true, Q: true, k: true, q: true };
    this.enPassantTarget = '-';
    this.halfmoveClock = 0;
    this.fullmoveNumber = 1;

    this.init();
  }

  init() {
    this.cacheElements();
    this.bindEvents();
    this.updatePhaseUI();
    this.setDefaultFEN();
    // Replace old Stockfish engine with PatriciaClient
    this.stockfish = new PatriciaClient();
  }

  // ============ ENGINE-AWARE FLOW ============
  async makeAIMove() {
    if (!this.gameActive || this.currentPlayer === this.playerSide) return;

    this.updateGameStatus('AI thinking...');

    const remainingMoves = this.maxMoves - this.moveCount[this.currentPlayer];
    const fen = this.currentFEN;
    const bestMove = await this.stockfish.getBestMove(fen, this.moveCount[this.currentPlayer], remainingMoves);

    if (!bestMove) {
      this.handleAIFallback();
      return;
    }

    this.executeAIMove(bestMove);
  }

  executeAIMove(moveString) {
    const fromSquare = this.algebraicToCoords(moveString.slice(0, 2));
    const toSquare = this.algebraicToCoords(moveString.slice(2, 4));
    const promoChar = moveString.length > 4 ? moveString.slice(4, 5) : null;

    const piece = this.board[fromSquare.rank][fromSquare.file];
    const capturedPiece = this.board[toSquare.rank][toSquare.file];

    const legality = this.isLegalMoveWithState(fromSquare, toSquare, piece, promoChar);
    if (!legality.ok) {
      this.handleAIFallback();
      return;
    }

    this.applyMoveToState({
      from: fromSquare,
      to: toSquare,
      piece,
      capturedPiece,
      promotion: legality.promotion || null,
      isEnPassant: legality.isEnPassant,
      isCastling: legality.isCastling
    });

    this.recordMove(fromSquare, toSquare, piece, capturedPiece, legality);
    this.endAITurn();
  }

  // ====== ALL EXISTING GAME/BOARD LOGIC BELOW (unchanged) ======

  mvvValue(piece) {
    const p = (piece || '').toLowerCase();
    switch (p) {
      case 'q': return 9;
      case 'r': return 5;
      case 'b': return 3;
      case 'n': return 3;
      case 'p': return 1;
      case 'k': return 100;
      default: return 0;
    }
  }

  scoreMVVLVA(move) {
    if (!move.capturedPiece && !move.meta?.isEnPassant) return 0;
    const victim = this.mvvValue(move.capturedPiece);
    const attacker = this.mvvValue(move.piece);
    let score = victim * 8 - attacker;
    if (move.meta?.promotion) score += 5;
    if (move.meta?.isEnPassant) score += 1;
    return score;
  }

  cacheElements() {
    this.els = {
      gamePhase: document.getElementById('gamePhase'),
      uploadPhase: document.getElementById('uploadPhase'),
      editPhase: document.getElementById('editPhase'),
      configPhase: document.getElementById('configPhase'),
      playPhase: document.getElementById('playPhase'),
      resultPhase: document.getElementById('resultPhase'),
      prevPhaseBtn: document.getElementById('prevPhaseBtn'),
      nextPhaseBtn: document.getElementById('nextPhaseBtn'),
      imageUpload: document.getElementById('imageUpload'),
      fenInput: document.getElementById('fenInput'),
      loadPositionBtn: document.getElementById('loadPositionBtn'),
      useDefaultBtn: document.getElementById('useDefaultBtn'),
      board: document.getElementById('board'),
      flipBtn: document.getElementById('flipBtn'),
      resetBoardBtn: document.getElementById('resetBoardBtn'),
      startPosBtn: document.getElementById('startPosBtn'),
      sparePieces: document.getElementById('sparePieces'),
      fenOutput: document.getElementById('fenOutput'),
      copyFenBtn: document.getElementById('copyFenBtn'),
      moveLimit: document.getElementById('moveLimit'),
      engineStrength: document.getElementById('engineStrength'),
      startGameBtn: document.getElementById('startGameBtn'),
      boardPlay: document.getElementById('boardPlay'),
      flipDuringPlayBtn: document.getElementById('flipDuringPlayBtn'),
      resignBtn: document.getElementById('resignBtn'),
      restartBtn: document.getElementById('restartBtn'),
      engineStatus: document.getElementById('engineStatus'),
      statusText: document.getElementById('statusText'),
      moveHistory: document.getElementById('moveHistory'),
      scoreWhite: document.getElementById('scoreWhite'),
      scoreBlack: document.getElementById('scoreBlack'),
      resultSummary: document.getElementById('resultSummary'),
      newSessionBtn: document.getElementById('newSessionBtn'),
      playAgainBtn: document.getElementById('playAgainBtn')
    };
  }

  bindEvents() {
    this.els.prevPhaseBtn?.addEventListener('click', () => this.prevPhase());
    this.els.nextPhaseBtn?.addEventListener('click', () => this.nextPhase());

    this.els.loadPositionBtn?.addEventListener('click', () => this.loadPosition());
    this.els.useDefaultBtn?.addEventListener('click', () => this.useDefaultPosition());
    this.els.flipBtn?.addEventListener('click', () => this.flipBoard());
    this.els.resetBoardBtn?.addEventListener('click', () => this.resetBoard());
    this.els.startPosBtn?.addEventListener('click', () => this.setStartPosition());
    this.els.copyFenBtn?.addEventListener('click', () => this.copyFEN());

    this.els.startGameBtn?.addEventListener('click', () => this.startGame());
    document.querySelectorAll('input[name="firstMove"]').forEach(radio => {
      radio.addEventListener('change', e => this.firstMove = e.target.value);
    });
    document.querySelectorAll('input[name="playerSide"]').forEach(radio => {
      radio.addEventListener('change', e => this.playerSide = e.target.value);
    });
    this.els.moveLimit?.addEventListener('change', e => {
      this.maxMoves = Math.max(1, Math.min(20, parseInt(e.target.value) || 6));
    });
    this.els.engineStrength?.addEventListener('change', e => {
      this.updateEngineStrength(e.target.value);
    });

    this.els.flipDuringPlayBtn?.addEventListener('click', () => this.flipBoard());
    this.els.resignBtn?.addEventListener('click', () => this.resignGame());
    this.els.restartBtn?.addEventListener('click', () => this.restartGame());

    this.els.newSessionBtn?.addEventListener('click', () => this.newSession());
    this.els.playAgainBtn?.addEventListener('click', () => this.playAgain());
  }

  updatePhaseUI() {
    const phases = [
      this.els.uploadPhase, this.els.editPhase, this.els.configPhase,
      this.els.playPhase, this.els.resultPhase
    ];

    phases.forEach((el, i) => { if (el) el.hidden = i !== this.currentPhase; });
    if (this.els.gamePhase) {
      this.els.gamePhase.textContent = `Phase ${this.currentPhase + 1}: ${this.phases[this.currentPhase]}`;
    }
    if (this.els.prevPhaseBtn) this.els.prevPhaseBtn.disabled = this.currentPhase === 0;
    if (this.els.nextPhaseBtn) this.els.nextPhaseBtn.disabled = this.currentPhase === phases.length - 1;

    if (this.currentPhase === 1) this.renderBoardEditor();
  }

  nextPhase() { if (this.currentPhase < 4) { this.currentPhase++; this.updatePhaseUI(); } }
  prevPhase() { if (this.currentPhase > 0) { this.currentPhase--; this.updatePhaseUI(); } }

  setDefaultFEN() {
    if (this.els.fenInput) this.els.fenInput.value = this.currentFEN;
  }

  loadPosition() {
    const fen = this.els.fenInput?.value?.trim();
    if (!fen || !this.validateFEN(fen)) {
      this.showToast('Invalid FEN string');
      return;
    }
    this.setPositionFromFEN(fen);
    this.showToast('Position loaded successfully');
    this.nextPhase();
  }

  useDefaultPosition() {
    this.setPositionFromFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    this.showToast('Default position loaded');
    this.nextPhase();
  }

  validateFEN(fen) {
    if (!fen || typeof fen !== 'string') return false;
    const parts = fen.split(' ');
    if (parts.length < 4) return false;

    const rows = parts[0].split('/');
    if (rows.length !== 8) return false;
    for (const row of rows) {
      let count = 0;
      for (const char of row) {
        if (/\d/.test(char)) count += parseInt(char, 10);
        else if (/[prnbqkPRNBQK]/.test(char)) count += 1;
        else return false;
      }
      if (count !== 8) return false;
    }
    if (!/^[wb]$/.test(parts[1])) return false;
    if (!/^(-|K?Q?k?q?)$/.test(parts[2])) return false;
    if (!/^(-|[a-h][36])$/.test(parts[3]) && !/^(-|[a-h])$/.test(parts[3])) return false;
    if (parts[4] && !/^\d+$/.test(parts[4])) return false;
    if (parts[5] && !/^\d+$/.test(parts[5])) return false;
    return true;
  }

  setPositionFromFEN(fen) {
    this.currentFEN = fen;
    const [placement, side, castling, ep, half, full] = fen.split(' ');
    this.board = this.parseFENPlacement(placement);
    this.currentPlayer = side === 'w' ? 'white' : 'black';
    this.castlingRights = {
      K: castling.includes('K'),
      Q: castling.includes('Q'),
      k: castling.includes('k'),
      q: castling.includes('q')
    };
    this.enPassantTarget = ep || '-';
    this.halfmoveClock = parseInt(half || '0', 10);
    this.fullmoveNumber = parseInt(full || '1', 10);

    if (this.els.fenOutput) this.els.fenOutput.value = this.currentFEN;
    if (this.currentPhase === 1) this.renderBoardEditor();
  }

  parseFENPlacement(placement) {
    const rows = placement.split('/');
    const board = this.createEmptyBoard();
    for (let rank = 0; rank < 8; rank++) {
      let file = 0;
      for (const char of rows[rank]) {
        if (/\d/.test(char)) {
          file += parseInt(char, 10);
        } else {
          board[rank][file] = char;
          file++;
        }
      }
    }
    return board;
  }

  boardToPlacement() {
    return this.board.map(row => {
      let fenRow = '';
      let emptyCount = 0;
      for (const piece of row) {
        if (!piece) emptyCount++;
        else {
          if (emptyCount > 0) { fenRow += emptyCount; emptyCount = 0; }
          fenRow += piece;
        }
      }
      if (emptyCount > 0) fenRow += emptyCount;
      return fenRow;
    }).join('/');
  }

  syncFENFromState() {
    const placement = this.boardToPlacement();
    const side = this.currentPlayer === 'white' ? 'w' : 'b';
    const c = `${this.castlingRights.K ? 'K' : ''}${this.castlingRights.Q ? 'Q' : ''}${this.castlingRights.k ? 'k' : ''}${this.castlingRights.q ? 'q' : ''}` || '-';
    const ep = this.enPassantTarget || '-';
    const half = Math.max(0, this.halfmoveClock | 0);
    const full = Math.max(1, this.fullmoveNumber | 0);
    this.currentFEN = `${placement} ${side} ${c} ${ep} ${half} ${full}`;
    if (this.els.fenOutput) this.els.fenOutput.value = this.currentFEN;
  }

  createEmptyBoard() { return Array.from({ length: 8 }, () => Array(8).fill(null)); }

  renderBoardEditor() {
    if (!this.els.board) return;
    this.els.board.innerHTML = '';
    const squares = this.getSquareOrder();
    squares.forEach(square => {
      const div = document.createElement('div');
      div.className = `square ${square.color}`;
      div.dataset.rank = square.rank;
      div.dataset.file = square.file;

      const piece = this.board[square.rank][square.file];
      if (piece) {
        div.textContent = this.pieceSymbols[piece];
        div.draggable = true;
        div.addEventListener('dragstart', e => this.handleDragStart(e, square));
      }

      div.addEventListener('dragover', e => this.handleDragOver(e));
      div.addEventListener('drop', e => this.handleDrop(e, square));
      div.addEventListener('dragenter', () => div.classList.add('drag-over'));
      div.addEventListener('dragleave', () => div.classList.remove('drag-over'));

      this.els.board.appendChild(div);
    });

    this.renderSparePieces();
    this.syncFENFromState();
  }

  renderBoardPlay() {
    if (!this.els.boardPlay) return;
    this.els.boardPlay.innerHTML = '';
    const squares = this.getSquareOrder();
    squares.forEach(square => {
      const div = document.createElement('div');
      div.className = `square ${square.color}`;
      div.dataset.rank = square.rank;
      div.dataset.file = square.file;

      const piece = this.board[square.rank][square.file];
      if (piece) {
        div.textContent = this.pieceSymbols[piece];
        if (this.gameActive && this.currentPlayer === this.playerSide &&
            this.isPieceOwnedByPlayer(piece, this.playerSide)) {
          div.draggable = true;
          div.addEventListener('dragstart', e => this.handlePlayDragStart(e, square));
        }
      }

      div.addEventListener('dragover', e => this.handleDragOver(e));
      div.addEventListener('drop', e => this.handlePlayDrop(e, square));

      this.els.boardPlay.appendChild(div);
    });
  }

  getSquareOrder() {
  const squares = [];
  // Default: White at bottom (rank 7 drawn last). If player is black, flip both axes.
  const ranks = this.isFlipped
    ? Array.from({ length: 8 }, (_, i) => i)        // flipped: a8 at bottom
    : Array.from({ length: 8 }, (_, i) => 7 - i);   // default: a1 at bottom

  const files = this.isFlipped
    ? Array.from({ length: 8 }, (_, i) => 7 - i)    // flip horizontally too
    : Array.from({ length: 8 }, (_, i) => i);

  ranks.forEach(rank => {
    files.forEach(file => {
      squares.push({ rank, file, color: (rank + file) % 2 === 0 ? 'light' : 'dark' });
    });
  });
  return squares;
}


  renderSparePieces() {
    if (!this.els.sparePieces) return;
    this.els.sparePieces.innerHTML = '';
    const pieces = ['K', 'Q', 'R', 'B', 'N', 'P', 'k', 'q', 'r', 'b', 'n', 'p'];
    pieces.forEach(piece => {
      const div = document.createElement('div');
      div.className = 'spare-piece';
      div.textContent = this.pieceSymbols[piece];
      div.draggable = true;
      div.addEventListener('dragstart', e => {
        e.dataTransfer.setData('piece', piece);
        this.dragSource = { spare: true, piece };
      });
      this.els.sparePieces.appendChild(div);
    });

    this.els.board?.querySelectorAll('.square').forEach(square => {
      square.addEventListener('drop', e => {
        if (this.dragSource?.spare) {
          const rank = parseInt(square.dataset.rank, 10);
          const file = parseInt(square.dataset.file, 10);
          const existingPiece = this.board[rank][file];
          if (existingPiece) {
            this.handleCapture(this.dragSource.piece, existingPiece);
          }
          this.board[rank][file] = this.dragSource.piece;
          this.syncFENFromState();
          this.renderBoardEditor();
        }
      });
    });
  }

  handleDragStart(e, square) { this.dragSource = square; e.dataTransfer.effectAllowed = 'move'; }
  handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }

  handleDrop(e, targetSquare) {
    e.preventDefault();
    e.target.classList.remove('drag-over');
    if (!this.dragSource) return;
    const piece = this.board[this.dragSource.rank][this.dragSource.file];
    if (!piece) return;
    const existingPiece = this.board[targetSquare.rank][targetSquare.file];
    if (existingPiece) this.handleCapture(piece, existingPiece);
    this.board[targetSquare.rank][targetSquare.file] = piece;
    this.board[this.dragSource.rank][this.dragSource.file] = null;
    this.dragSource = null;
    this.syncFENFromState();
    this.renderBoardEditor();
  }

  handlePlayDragStart(e, square) { this.dragSource = square; e.dataTransfer.effectAllowed = 'move'; }

  handlePlayDrop(e, targetSquare) {
    e.preventDefault();
    if (!this.dragSource || !this.gameActive) return;

    const from = { rank: this.dragSource.rank, file: this.dragSource.file };
    const to = { rank: targetSquare.rank, file: targetSquare.file };
    const piece = this.board[from.rank][from.file];
    if (!piece) return;

    const legalMove = this.isLegalMoveWithState(from, to, piece);
    // Enforce “must escape check” when currently checked
    const color = /[PRNBQK]/.test(piece) ? 'white' : 'black';
    if (this.isKingInCheck(color)) {
    const snapshot = this.snapshotState();
    this.applyMoveToState({
    from, to, piece,
    capturedPiece: this.board[to.rank][to.file],
    promotion: legalMove.promotion || null,
    isEnPassant: legalMove.isEnPassant,
    isCastling: legalMove.isCastling
    }, { simulate: true });
    const stillChecked = this.isKingInCheck(color);
    this.restoreSnapshot(snapshot);
    if (stillChecked) {
    this.showToast('Must escape check');
    return;
    }
  }

    if (!legalMove.ok) { this.showToast(legalMove.reason || 'Illegal move'); return; }

    const capturedPiece = this.board[to.rank][to.file];

    this.applyMoveToState({ from, to, piece, capturedPiece, promotion: legalMove.promotion || null, isEnPassant: legalMove.isEnPassant, isCastling: legalMove.isCastling });
    this.recordMove(from, to, piece, capturedPiece, legalMove);

    this.endPlayerTurn();
  }

  startGame() {
    const flatBoard = this.board.flat();
    if (!flatBoard.includes('K') || !flatBoard.includes('k')) {
      this.showToast('Both kings must be present on the board');
      return;
    }

    this.currentPlayer = this.firstMove;
    this.moveCount = { white: 0, black: 0 };
    this.scores = { white: 0, black: 0 };
    this.moveHistory = [];
    this.gameActive = true;
    this.gameResult = null;

    this.currentPhase = 3;
    this.updatePhaseUI();
    this.renderBoardPlay();
    this.updateGameStatus();
    this.updateScoreDisplay();

    this.syncFENFromState();

    if (this.currentPlayer !== this.playerSide) {
      setTimeout(() => this.makeAIMove(), 500);
    }
  }

  endPlayerTurn() {
    this.moveCount[this.currentPlayer]++;
    if (this.checkGameEndEarly()) return;

    this.currentPlayer = this.currentPlayer === 'white' ? 'black' : 'white';
    if (this.currentPlayer === 'white') this.fullmoveNumber++;
    this.syncFENFromState();

    if (this.checkGameEnd()) return;

    this.renderBoardPlay();
    this.updateGameStatus();

    if (this.currentPlayer !== this.playerSide) {
      setTimeout(() => this.makeAIMove(), 300);
    }
  }

  endAITurn() {
    this.moveCount[this.currentPlayer]++;
    if (this.checkGameEndEarly()) return;

    this.currentPlayer = this.currentPlayer === 'white' ? 'black' : 'white';
    if (this.currentPlayer === 'white') this.fullmoveNumber++;
    this.syncFENFromState();

    if (this.checkGameEnd()) return;

    this.renderBoardPlay();
    this.updateGameStatus();
  }

  checkGameEndEarly() {
    const playerToMove = this.currentPlayer;
    const hasMoves = this.generateAllLegalMoves(playerToMove).length > 0;
    const inCheck = this.isKingInCheck(playerToMove);

    if (!hasMoves) {
      this.endGame(inCheck ? 'Checkmate' : 'Stalemate');
      return true;
    }
    return false;
  }

  checkGameEnd() {
    if (this.moveCount.white >= this.maxMoves && this.moveCount.black >= this.maxMoves) {
      this.endGame('Move limit reached');
      return true;
    }
    return false;
  }

  endGame(reason) {
    this.gameActive = false;
    const winner = this.determineWinnerByReason(reason);
    this.gameResult = {
      reason,
      winner,
      finalScore: { ...this.scores },
      totalMoves: this.moveCount.white + this.moveCount.black
    };

    this.currentPhase = 4;
    this.updatePhaseUI();
    this.displayResults();
  }

  determineWinnerByReason(reason) {
    if (reason === 'Checkmate') {
      return this.currentPlayer === 'white' ? 'Black' : 'White';
    }
    if (this.scores.white > this.scores.black) return 'White';
    if (this.scores.black > this.scores.white) return 'Black';
    return 'Draw';
  }

  displayResults() {
    if (!this.els.resultSummary || !this.gameResult) return;
    const { winner, reason, finalScore, totalMoves } = this.gameResult;
    this.els.resultSummary.innerHTML = `
      <div class="result-header">
        <h3>${winner === 'Draw' ? 'Game Drawn' : `${winner} Wins!`}</h3>
        <p class="result-reason">${reason}</p>
      </div>
      <div class="result-stats">
        <div class="stat-row">
          <span>Final Score:</span>
          <span>White ${finalScore.white} - ${finalScore.black} Black</span>
        </div>
        <div class="stat-row">
          <span>Total Moves:</span>
          <span>${totalMoves} moves</span>
        </div>
        <div class="stat-row">
          <span>Engine:</span>
          <span>Patricia</span>
        </div>
      </div>
    `;
  }

  algebraicToCoords(algebraic) {
    const file = algebraic.charCodeAt(0) - 97;
    const rank = 8 - parseInt(algebraic[1], 10);
    return { rank, file };
  }

  coordsToAlgebraic(coords) {
    const file = String.fromCharCode(97 + coords.file);
    const rank = (8 - coords.rank).toString();
    return file + rank;
  }

  isPieceOwnedByPlayer(piece, player) {
    return player === 'white' ? /[PRNBQK]/.test(piece) : /[prnbqk]/.test(piece);
  }

  isSameColor(piece1, piece2) {
    return (/[PRNBQK]/.test(piece1) && /[PRNBQK]/.test(piece2)) ||
           (/[prnbqk]/.test(piece1) && /[prnbqk]/.test(piece2));
  }

  isLegalMoveWithState(from, to, piece, promotionChar = null) {
    if (!piece) return { ok: false, reason: 'No piece' };
    if (from.rank === to.rank && from.file === to.file) return { ok: false, reason: 'Same square' };

    const targetPiece = this.board[to.rank][to.file];
    if (targetPiece && this.isSameColor(piece, targetPiece)) return { ok: false, reason: 'Own piece on target' };

    const color = /[PRNBQK]/.test(piece) ? 'white' : 'black';
    if (color !== this.currentPlayer) return { ok: false, reason: 'Not turn' };

    const deltas = { dr: to.rank - from.rank, df: to.file - from.file };
    let isEnPassant = false;
    let isCastling = false;
    let promotion = null;

    const abs = (x) => Math.abs(x);

    const pathClear = (drStep, dfStep, steps) => {
      for (let i = 1; i < steps; i++) {
        const r = from.rank + drStep * i;
        const f = from.file + dfStep * i;
        if (this.board[r][f]) return false;
      }
      return true;
    };

    const pieceLower = piece.toLowerCase();

    if (pieceLower === 'p') {
      const dir = color === 'white' ? -1 : 1;
      const startRank = color === 'white' ? 6 : 1;
      if (deltas.df === 0) {
        if (deltas.dr === dir && !targetPiece) { /* ok */ }
        else if (from.rank === startRank && deltas.dr === 2 * dir && !targetPiece) {
          if (this.board[from.rank + dir][from.file]) return { ok: false, reason: 'Blocked' };
        } else return { ok: false, reason: 'Bad pawn move' };
      } else if (abs(deltas.df) === 1 && deltas.dr === dir) {
        if (targetPiece) { /* capture ok */ }
        else {
          const ep = this.enPassantTarget;
          if (ep !== '-') {
            const epCoords = this.algebraicToCoords(ep);
            if (epCoords.rank === to.rank && epCoords.file === to.file) {
              isEnPassant = true;
            } else return { ok: false, reason: 'No EP' };
          } else return { ok: false, reason: 'No EP' };
        }
      } else return { ok: false, reason: 'Bad pawn vector' };
      const promoRank = color === 'white' ? 0 : 7;
      if (to.rank === promoRank) {
        const pch = promotionChar || 'q';
        promotion = color === 'white' ? pch.toUpperCase() : pch.toLowerCase();
        if (!/[qrbnQRBN]/.test(promotion)) promotion = color === 'white' ? 'Q' : 'q';
      }
    } else if (pieceLower === 'n') {
      const ok = (abs(deltas.dr) === 2 && abs(deltas.df) === 1) || (abs(deltas.dr) === 1 && abs(deltas.df) === 2);
      if (!ok) return { ok: false, reason: 'Bad knight move' };
    } else if (pieceLower === 'b') {
      if (abs(deltas.dr) !== abs(deltas.df)) return { ok: false, reason: 'Bad bishop move' };
      if (!pathClear(Math.sign(deltas.dr), Math.sign(deltas.df), abs(deltas.dr))) return { ok: false, reason: 'Blocked' };
    } else if (pieceLower === 'r') {
      if (!(deltas.dr === 0 || deltas.df === 0)) return { ok: false, reason: 'Bad rook move' };
      const steps = abs(deltas.dr) + abs(deltas.df);
      const dr = deltas.dr === 0 ? 0 : Math.sign(deltas.dr);
      const df = deltas.df === 0 ? 0 : Math.sign(deltas.df);
      if (!pathClear(dr, df, steps)) return { ok: false, reason: 'Blocked' };
    } else if (pieceLower === 'q') {
      if (!(abs(deltas.dr) === abs(deltas.df) || deltas.dr === 0 || deltas.df === 0)) return { ok: false, reason: 'Bad queen move' };
      const steps = Math.max(abs(deltas.dr), abs(deltas.df));
      const dr = deltas.dr === 0 ? 0 : Math.sign(deltas.dr);
      const df = deltas.df === 0 ? 0 : Math.sign(deltas.df);
      if (!pathClear(dr, df, steps)) return { ok: false, reason: 'Blocked' };
    } else if (pieceLower === 'k') {
      if (deltas.dr === 0 && abs(deltas.df) === 2) {
        const rights = this.castlingRights;
        const sideKing = color === 'white' ? { rank: 7, file: 4 } : { rank: 0, file: 4 };
        if (from.rank !== sideKing.rank || from.file !== sideKing.file) return { ok: false, reason: 'King not on start' };
        const kingSide = to.file === 6;
        const queenSide = to.file === 2;
        if (!kingSide && !queenSide) return { ok: false, reason: 'Bad castle target' };
        const canCastle = color === 'white' ? (kingSide ? rights.K : rights.Q) : (kingSide ? rights.k : rights.q);
        if (!canCastle) return { ok: false, reason: 'No castling rights' };
        const rookFile = kingSide ? 7 : 0;
        const step = kingSide ? 1 : -1;
        for (let f = from.file + step; f !== rookFile; f += step) {
          if (this.board[from.rank][f]) return { ok: false, reason: 'Path blocked' };
        }
        if (this.isSquareAttacked(from, color)) return { ok: false, reason: 'King in check' };
        const mid = { rank: from.rank, file: from.file + step };
        if (this.isSquareAttacked(mid, color)) return { ok: false, reason: 'Through check' };
        if (this.isSquareAttacked(to, color)) return { ok: false, reason: 'Into check' };
        isCastling = true;
      } else {
        if (abs(deltas.dr) > 1 || abs(deltas.df) > 1) return { ok: false, reason: 'Bad king move' };
      }
    }

    const snapshot = this.snapshotState();
    this.applyMoveToState({ from, to, piece, capturedPiece: targetPiece, promotion, isEnPassant, isCastling }, { simulate: true });
    const stillInCheck = this.isKingInCheck(color);
    this.restoreSnapshot(snapshot);
    if (stillInCheck) return { ok: false, reason: 'Leaves king in check' };

    return { ok: true, isEnPassant, isCastling, promotion };
  }

  snapshotState() {
    return {
      board: this.board.map(r => r.slice()),
      castlingRights: { ...this.castlingRights },
      enPassantTarget: this.enPassantTarget,
      halfmoveClock: this.halfmoveClock,
      fullmoveNumber: this.fullmoveNumber,
      currentPlayer: this.currentPlayer
    };
  }

  restoreSnapshot(s) {
    this.board = s.board.map(r => r.slice());
    this.castlingRights = { ...s.castlingRights };
    this.enPassantTarget = s.enPassantTarget;
    this.halfmoveClock = s.halfmoveClock;
    this.fullmoveNumber = s.fullmoveNumber;
    this.currentPlayer = s.currentPlayer;
  }

  applyMoveToState(move, options = {}) {
    const { from, to, piece, capturedPiece, promotion, isEnPassant, isCastling } = move;
    if (!piece) {
      console.warn('applyMoveToState called with undefined piece:', move);
      return;
    }
    const color = /[PRNBQK]/.test(piece) ? 'white' : 'black';

    if (piece.toLowerCase() === 'p' || capturedPiece || isEnPassant) this.halfmoveClock = 0;
    else this.halfmoveClock++;

    if (isEnPassant) {
      const dir = color === 'white' ? 1 : -1;
      this.board[to.rank + dir][to.file] = null;
    }

    if (isCastling) {
      const kingSide = to.file === 6;
      const rookFrom = { rank: from.rank, file: kingSide ? 7 : 0 };
      const rookTo = { rank: from.rank, file: kingSide ? 5 : 3 };
      const rook = this.board[rookFrom.rank][rookFrom.file];
      this.board[rookFrom.rank][rookFrom.file] = null;
      this.board[rookTo.rank][rookTo.file] = rook;
    }

    this.board[to.rank][to.file] = piece;
    this.board[from.rank][from.file] = null;

    if (promotion) {
      this.board[to.rank][to.file] = promotion;
    }

    const updateCR = (p, r, f) => {
      if (!p) return;
      if (p === 'K') { this.castlingRights.K = false; this.castlingRights.Q = false; }
      if (p === 'k') { this.castlingRights.k = false; this.castlingRights.q = false; }
      if (p === 'R' && r === 7 && f === 0) this.castlingRights.Q = false;
      if (p === 'R' && r === 7 && f === 7) this.castlingRights.K = false;
      if (p === 'r' && r === 0 && f === 0) this.castlingRights.q = false;
      if (p === 'r' && r === 0 && f === 7) this.castlingRights.k = false;
    };
    updateCR(piece, from.rank, from.file);
    updateCR(capturedPiece, to.rank, to.file);

    if (piece.toLowerCase() === 'p' && Math.abs(to.rank - from.rank) === 2) {
      const midRank = (to.rank + from.rank) / 2;
      this.enPassantTarget = this.coordsToAlgebraic({ rank: midRank, file: from.file });
    } else {
      this.enPassantTarget = '-';
    }

    if (!options.simulate) {
      this.syncFENFromState();
      this.updateScoreOnCapture(piece, capturedPiece);
    }
  }

  updateScoreOnCapture(attacker, victim) {
    if (!victim) return;
    const attackerColor = /[PRNBQK]/.test(attacker) ? 'white' : 'black';
    const points = this.pieceValues[victim] || 0;
    this.scores[attackerColor] += points;
    this.updateScoreDisplay();
  }

  isSquareAttacked(square, color) {
    const attacker = color === 'white' ? 'black' : 'white';
    const attacks = this.generateAllPseudoLegalMoves(attacker, { includeKingSafety: false });
    return attacks.some(m => m.to.rank === square.rank && m.to.file === square.file);
  }

  isKingInCheck(color) {
    const kingPiece = color === 'white' ? 'K' : 'k';
    let kingSq = null;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) if (this.board[r][f] === kingPiece) kingSq = { rank: r, file: f };
    if (!kingSq) return false;
    return this.isSquareAttacked(kingSq, color);
  }

  generateAllPseudoLegalMoves(player, opts = {}) {
    const includeKingSafety = opts.includeKingSafety !== false;
    const moves = [];
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = this.board[rank][file];
        if (!piece || !this.isPieceOwnedByPlayer(piece, player)) continue;
        const from = { rank, file };
        for (let toRank = 0; toRank < 8; toRank++) {
          for (let toFile = 0; toFile < 8; toFile++) {
            const to = { rank: toRank, file: toFile };
            const res = this.isLegalMoveWithState(from, to, piece);
            if (res.ok) {
              moves.push({ from, to, piece, capturedPiece: this.board[toRank][toFile], meta: res });
            }
          }
        }
      }
    }
    return moves;
  }

  generateAllLegalMoves(player) {
    return this.generateAllPseudoLegalMoves(player, { includeKingSafety: true });
  }

  handleCapture(attacker, victim) {
    const attackerColor = /[PRNBQK]/.test(attacker) ? 'white' : 'black';
    const points = this.pieceValues[victim] || 0;
    this.scores[attackerColor] += points;
    this.updateScoreDisplay();
  }

  recordMove(from, to, piece, capturedPiece, meta = {}) {
    const moveNotation = this.generateMoveNotation(from, to, piece, capturedPiece, meta);
    this.moveHistory.push(moveNotation);
    this.updateMoveHistory();
  }

  generateMoveNotation(from, to, piece, capturedPiece, meta = {}) {
    const files = 'abcdefgh';
    const fromSquare = files[from.file] + (8 - from.rank);
    const toSquare = files[to.file] + (8 - to.rank);
    const capture = capturedPiece || meta.isEnPassant ? 'x' : '-';
    if (meta.isCastling) return to.file === 6 ? 'O-O' : 'O-O-O';
    let p = piece.toUpperCase() === 'P' ? '' : piece.toUpperCase();
    let promo = meta.promotion ? `=${meta.promotion.toUpperCase()}` : '';
    return `${p}${capture}${toSquare}${promo}`;
  }

  updateMoveHistory() {
    if (!this.els.moveHistory) return;
    this.els.moveHistory.innerHTML = '';
    this.moveHistory.forEach((move, index) => {
      const li = document.createElement('li');
      li.textContent = `${index + 1}. ${move}`;
      this.els.moveHistory.appendChild(li);
    });
    this.els.moveHistory.scrollTop = this.els.moveHistory.scrollHeight;
  }

  updateScoreDisplay() {
    if (this.els.scoreWhite) this.els.scoreWhite.textContent = this.scores.white;
    if (this.els.scoreBlack) this.els.scoreBlack.textContent = this.scores.black;
  }

  updateGameStatus(message) {
    if (!this.els.statusText) return;
    if (message) {
      this.els.statusText.textContent = message;
    } else {
      const whiteMoves = this.moveCount.white;
      const blackMoves = this.moveCount.black;
      this.els.statusText.textContent =
        `${this.currentPlayer === this.playerSide ? 'Your' : 'AI'} turn • ` +
        `Moves: W ${whiteMoves}/${this.maxMoves} B ${blackMoves}/${this.maxMoves}`;
    }
  }

  updateEngineStrength(strength) {
    // Optional: wire strength to movetime heuristic
    if (!this.stockfish) return;
    switch (strength) {
      case 'max':
        this.stockfish.defaultMoveTimeMs = 1200;
        break;
      case 'high':
        this.stockfish.defaultMoveTimeMs = 1000;
        break;
      case 'medium':
        this.stockfish.defaultMoveTimeMs = 800;
        break;
    }
  }

  flipBoard() {
    this.isFlipped = !this.isFlipped;
    if (this.currentPhase === 1) this.renderBoardEditor();
    else if (this.currentPhase === 3) this.renderBoardPlay();
  }
  resetBoard() {
    this.board = this.createEmptyBoard();
    this.syncFENFromState();
    this.renderBoardEditor();
    this.showToast('Board cleared');
  }
  setStartPosition() {
    this.setPositionFromFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    this.renderBoardEditor();
    this.showToast('Starting position set');
  }
  async copyFEN() {
    try {
      await navigator.clipboard.writeText(this.currentFEN);
      this.showToast('FEN copied to clipboard');
    } catch (error) {
      console.error('Failed to copy FEN:', error);
      this.showToast('Failed to copy FEN');
    }
  }
  resignGame() { if (this.gameActive) this.endGame(`${this.playerSide} resigned`); }
  restartGame() { this.currentPhase = 2; this.updatePhaseUI(); }
  newSession() {
    this.board = this.createEmptyBoard();
    this.currentFEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    this.scores = { white: 0, black: 0 };
    this.moveHistory = [];
    this.moveCount = { white: 0, black: 0 };
    this.gameActive = false;
    this.isFlipped = false;
    this.castlingRights = { K: true, Q: true, k: true, q: true };
    this.enPassantTarget = '-';
    this.halfmoveClock = 0;
    this.fullmoveNumber = 1;

    this.currentPhase = 0;
    this.updatePhaseUI();
    this.setDefaultFEN();
    this.updateScoreDisplay();
    if (this.els.moveHistory) this.els.moveHistory.innerHTML = '';
  }
  playAgain() { this.currentPhase = 2; this.updatePhaseUI(); }
  showToast(message, duration = 2000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => document.body.removeChild(toast), 300);
    }, duration);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.chessGame = new ChessGame();
});
