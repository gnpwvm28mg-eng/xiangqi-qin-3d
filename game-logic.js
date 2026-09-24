/*
 * Self-contained Chinese chess (Xiangqi) rules and a small browser-friendly AI.
 *
 * Coordinates use x=0..8 from left to right and y=0..9 from Black's side to
 * Red's side. Red moves towards decreasing y; Black moves towards increasing y.
 * A piece is represented by an upper-case letter for Red and lower-case for
 * Black: K/k king, A/a advisor, B/b elephant, N/n horse, R/r chariot,
 * C/c cannon, P/p soldier.
 */

const WIDTH = 9;
const HEIGHT = 10;
const BOARD_SIZE = WIDTH * HEIGHT;
const FILES = 'abcdefghi';
const PIECE_VALUES = Object.freeze({
  p: 100,
  n: 320,
  b: 250,
  a: 250,
  r: 900,
  c: 450,
  k: 10000,
});

// Rendering-friendly metadata. The board itself intentionally stores compact
// character codes; use PIECES[piece] to resolve the Chinese label and unit role.
const PIECES = Object.freeze({
  K: Object.freeze({ side: 'red', type: 'king', label: '帅', unit: 'commander' }),
  A: Object.freeze({ side: 'red', type: 'advisor', label: '仕', unit: 'guard' }),
  B: Object.freeze({ side: 'red', type: 'elephant', label: '相', unit: 'elephant' }),
  N: Object.freeze({ side: 'red', type: 'horse', label: '马', unit: 'cavalry' }),
  R: Object.freeze({ side: 'red', type: 'chariot', label: '车', unit: 'chariot' }),
  C: Object.freeze({ side: 'red', type: 'cannon', label: '炮', unit: 'artillery' }),
  P: Object.freeze({ side: 'red', type: 'soldier', label: '兵', unit: 'infantry' }),
  k: Object.freeze({ side: 'black', type: 'king', label: '将', unit: 'commander' }),
  a: Object.freeze({ side: 'black', type: 'advisor', label: '士', unit: 'guard' }),
  b: Object.freeze({ side: 'black', type: 'elephant', label: '象', unit: 'elephant' }),
  n: Object.freeze({ side: 'black', type: 'horse', label: '马', unit: 'cavalry' }),
  r: Object.freeze({ side: 'black', type: 'chariot', label: '车', unit: 'chariot' }),
  c: Object.freeze({ side: 'black', type: 'cannon', label: '砲', unit: 'artillery' }),
  p: Object.freeze({ side: 'black', type: 'soldier', label: '卒', unit: 'infantry' }),
});

const KNIGHT_STEPS = Object.freeze([
  [-1, -2, -1, 0],
  [1, -2, 1, 0],
  [-1, 2, -1, 0],
  [1, 2, 1, 0],
  [-2, -1, 0, -1],
  [2, -1, 0, -1],
  [-2, 1, 0, 1],
  [2, 1, 0, 1],
]);
const DIAGONALS = Object.freeze([
  [-1, -1], [1, -1], [-1, 1], [1, 1],
]);
const ORTHOGONALS = Object.freeze([
  [0, -1], [0, 1], [-1, 0], [1, 0],
]);

function isRedPiece(piece) {
  return typeof piece === 'string' && piece !== '' && piece === piece.toUpperCase();
}

function isBlackPiece(piece) {
  return typeof piece === 'string' && piece !== '' && piece === piece.toLowerCase();
}

function sideOf(piece) {
  if (isRedPiece(piece)) return 'red';
  if (isBlackPiece(piece)) return 'black';
  return null;
}

function opponent(side) {
  return side === 'red' ? 'black' : 'red';
}

function indexOf(x, y) {
  return y * WIDTH + x;
}

function xOf(index) {
  return index % WIDTH;
}

function yOf(index) {
  return Math.floor(index / WIDTH);
}

function inBounds(x, y) {
  return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
}

function normalizeSide(side) {
  return side === 'black' || side === 'b' ? 'black' : 'red';
}

function pieceType(piece) {
  return typeof piece === 'string' ? piece.toLowerCase() : '';
}

function createInitialBoard() {
  const board = Array(BOARD_SIZE).fill(null);
  const put = (row, text) => {
    [...text].forEach((piece, x) => {
      board[indexOf(x, row)] = piece === '.' ? null : piece;
    });
  };

  // Black is at the top, Red at the bottom.
  put(0, 'rnbakabnr');
  put(2, '.c.....c.');
  put(3, 'p.p.p.p.p');
  put(6, 'P.P.P.P.P');
  put(7, '.C.....C.');
  put(9, 'RNBAKABNR');
  return board;
}

function cloneBoard(board) {
  return Array.from(board, (piece) => piece || null);
}

function initialBoard() {
  return createInitialBoard();
}

function boardToFen(board, turn = 'red') {
  const rows = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    let row = '';
    let empty = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const piece = board[indexOf(x, y)];
      if (!piece) {
        empty += 1;
      } else {
        if (empty) row += String(empty);
        empty = 0;
        row += piece;
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  return `${rows.join('/')} ${normalizeSide(turn) === 'red' ? 'r' : 'b'}`;
}

function boardFromFen(fen) {
  if (typeof fen !== 'string') throw new TypeError('FEN must be a string');
  const fields = fen.trim().split(/\s+/);
  const rows = fields[0].split('/');
  if (rows.length !== HEIGHT) throw new Error('Invalid Xiangqi FEN: expected 10 rows');
  const board = Array(BOARD_SIZE).fill(null);
  rows.forEach((row, y) => {
    let x = 0;
    for (const token of row) {
      if (/^[1-9]$/.test(token)) {
        x += Number(token);
      } else if (/^[kabrncpKABRNCP]$/.test(token)) {
        if (x >= WIDTH) throw new Error('Invalid Xiangqi FEN row width');
        board[indexOf(x, y)] = token;
        x += 1;
      } else {
        throw new Error(`Invalid Xiangqi FEN token: ${token}`);
      }
    }
    if (x !== WIDTH) throw new Error('Invalid Xiangqi FEN row width');
  });
  return { board, turn: fields[1] === 'b' ? 'black' : 'red' };
}

function isInsidePalace(side, x, y) {
  if (x < 3 || x > 5) return false;
  return side === 'red' ? y >= 7 && y <= 9 : y >= 0 && y <= 2;
}

function crossedRiver(side, y) {
  return side === 'red' ? y <= 4 : y >= 5;
}

function findKing(board, side) {
  const king = side === 'red' ? 'K' : 'k';
  for (let i = 0; i < BOARD_SIZE; i += 1) {
    if (board[i] === king) return { x: xOf(i), y: yOf(i), index: i };
  }
  return null;
}

function countBetween(board, fromX, fromY, toX, toY) {
  let count = 0;
  if (fromX === toX) {
    const step = toY > fromY ? 1 : -1;
    for (let y = fromY + step; y !== toY; y += step) {
      if (board[indexOf(fromX, y)]) count += 1;
    }
  } else if (fromY === toY) {
    const step = toX > fromX ? 1 : -1;
    for (let x = fromX + step; x !== toX; x += step) {
      if (board[indexOf(x, fromY)]) count += 1;
    }
  }
  return count;
}

/*
 * Pseudo-legal attack test. This intentionally does not call legalMoves so it
 * can be used while testing whether a king is in check without recursion.
 */
function attacksSquare(board, fromX, fromY, toX, toY) {
  const piece = board[indexOf(fromX, fromY)];
  if (!piece || !inBounds(toX, toY)) return false;
  const side = sideOf(piece);
  const type = pieceType(piece);
  const dx = toX - fromX;
  const dy = toY - fromY;

  if (type === 'k') {
    // A king attacks adjacent palace squares and also a king on the same file
    // (the latter is handled as the flying-general rule).
    if (Math.abs(dx) + Math.abs(dy) === 1) return isInsidePalace(side, toX, toY);
    if (dx === 0) return countBetween(board, fromX, fromY, toX, toY) === 0;
    return false;
  }
  if (type === 'a') {
    return Math.abs(dx) === 1 && Math.abs(dy) === 1 && isInsidePalace(side, toX, toY);
  }
  if (type === 'b') {
    if (Math.abs(dx) !== 2 || Math.abs(dy) !== 2) return false;
    const eyeX = fromX + dx / 2;
    const eyeY = fromY + dy / 2;
    return !board[indexOf(eyeX, eyeY)] && (side === 'red' ? toY >= 5 : toY <= 4);
  }
  if (type === 'n') {
    return KNIGHT_STEPS.some(([mx, my, lx, ly]) => (
      dx === mx && dy === my && inBounds(fromX + lx, fromY + ly)
      && !board[indexOf(fromX + lx, fromY + ly)]
    ));
  }
  if (type === 'r') {
    return (dx === 0 || dy === 0) && !(dx === 0 && dy === 0)
      && countBetween(board, fromX, fromY, toX, toY) === 0;
  }
  if (type === 'c') {
    return (dx === 0 || dy === 0) && !(dx === 0 && dy === 0)
      && countBetween(board, fromX, fromY, toX, toY) === 1;
  }
  if (type === 'p') {
    const forward = side === 'red' ? -1 : 1;
    if (dy === forward && dx === 0) return true;
    return crossedRiver(side, fromY) && dy === 0 && Math.abs(dx) === 1;
  }
  return false;
}

function isInCheck(board, side) {
  const king = findKing(board, side);
  if (!king) return true;
  const enemy = opponent(side);
  for (let i = 0; i < BOARD_SIZE; i += 1) {
    const piece = board[i];
    if (piece && sideOf(piece) === enemy && attacksSquare(board, xOf(i), yOf(i), king.x, king.y)) {
      return true;
    }
  }
  return false;
}

function addIfReachable(board, side, fromX, fromY, toX, toY, moves, captureMode = 'normal') {
  if (!inBounds(toX, toY)) return;
  const target = board[indexOf(toX, toY)];
  if (target && sideOf(target) === side) return;
  if (captureMode === 'empty' && target) return;
  if (captureMode === 'capture' && !target) return;
  moves.push({
    from: { x: fromX, y: fromY },
    to: { x: toX, y: toY },
    piece: board[indexOf(fromX, fromY)],
    captured: target || null,
  });
}

function generatePseudoMoves(board, side) {
  const moves = [];
  for (let i = 0; i < BOARD_SIZE; i += 1) {
    const piece = board[i];
    if (!piece || sideOf(piece) !== side) continue;
    const fromX = xOf(i);
    const fromY = yOf(i);
    const type = pieceType(piece);

    if (type === 'k') {
      for (const [dx, dy] of ORTHOGONALS) {
        const toX = fromX + dx;
        const toY = fromY + dy;
        if (isInsidePalace(side, toX, toY)) addIfReachable(board, side, fromX, fromY, toX, toY, moves);
      }
      // Flying general capture is a legal king move when the opposing king is
      // exposed on the same file.
      const forward = side === 'red' ? -1 : 1;
      for (let y = fromY + forward; inBounds(fromX, y); y += forward) {
        const target = board[indexOf(fromX, y)];
        if (!target) continue;
        if (target === (side === 'red' ? 'k' : 'K')) {
          if (countBetween(board, fromX, fromY, fromX, y) === 0) {
            addIfReachable(board, side, fromX, fromY, fromX, y, moves, 'capture');
          }
        }
        break;
      }
      continue;
    }

    if (type === 'a') {
      for (const [dx, dy] of DIAGONALS) {
        const toX = fromX + dx;
        const toY = fromY + dy;
        if (isInsidePalace(side, toX, toY)) addIfReachable(board, side, fromX, fromY, toX, toY, moves);
      }
      continue;
    }

    if (type === 'b') {
      for (const [dx, dy] of DIAGONALS) {
        const toX = fromX + 2 * dx;
        const toY = fromY + 2 * dy;
        const eye = board[indexOf(fromX + dx, fromY + dy)];
        if (!eye && inBounds(toX, toY) && (side === 'red' ? toY >= 5 : toY <= 4)) {
          addIfReachable(board, side, fromX, fromY, toX, toY, moves);
        }
      }
      continue;
    }

    if (type === 'n') {
      for (const [dx, dy, lx, ly] of KNIGHT_STEPS) {
        const toX = fromX + dx;
        const toY = fromY + dy;
        if (inBounds(toX, toY) && inBounds(fromX + lx, fromY + ly)
          && !board[indexOf(fromX + lx, fromY + ly)]) {
          addIfReachable(board, side, fromX, fromY, toX, toY, moves);
        }
      }
      continue;
    }

    if (type === 'r' || type === 'c') {
      for (const [dx, dy] of ORTHOGONALS) {
        let toX = fromX + dx;
        let toY = fromY + dy;
        let screenCount = 0;
        while (inBounds(toX, toY)) {
          const target = board[indexOf(toX, toY)];
          if (type === 'r') {
            if (!target) {
              addIfReachable(board, side, fromX, fromY, toX, toY, moves, 'empty');
            } else {
              if (sideOf(target) !== side) addIfReachable(board, side, fromX, fromY, toX, toY, moves, 'capture');
              break;
            }
          } else if (!target) {
            if (screenCount === 0) addIfReachable(board, side, fromX, fromY, toX, toY, moves, 'empty');
          } else if (screenCount === 0) {
            screenCount = 1;
          } else {
            if (sideOf(target) !== side) addIfReachable(board, side, fromX, fromY, toX, toY, moves, 'capture');
            break;
          }
          toX += dx;
          toY += dy;
        }
      }
      continue;
    }

    if (type === 'p') {
      const forward = side === 'red' ? -1 : 1;
      addIfReachable(board, side, fromX, fromY, fromX, fromY + forward, moves);
      if (crossedRiver(side, fromY)) {
        addIfReachable(board, side, fromX, fromY, fromX - 1, fromY, moves);
        addIfReachable(board, side, fromX, fromY, fromX + 1, fromY, moves);
      }
    }
  }
  return moves;
}

function applyMoveToBoard(board, move) {
  const next = cloneBoard(board);
  const fromIndex = indexOf(move.from.x, move.from.y);
  const toIndex = indexOf(move.to.x, move.to.y);
  const piece = next[fromIndex];
  next[fromIndex] = null;
  next[toIndex] = piece;
  return next;
}

function moveKey(move) {
  return `${move.from.x},${move.from.y}-${move.to.x},${move.to.y}`;
}

function sameMove(a, b) {
  return !!a && !!b && a.from.x === b.from.x && a.from.y === b.from.y
    && a.to.x === b.to.x && a.to.y === b.to.y;
}

function cloneMove(move) {
  return {
    from: { ...move.from },
    to: { ...move.to },
    piece: move.piece,
    captured: move.captured || null,
  };
}

function withRowCol(move) {
  if (!move) return null;
  return {
    ...cloneMove(move),
    from: { x: move.from.x, y: move.from.y, row: move.from.y, col: move.from.x },
    to: { x: move.to.x, y: move.to.y, row: move.to.y, col: move.to.x },
  };
}

function normalizeMoveCoordinates(move) {
  if (!move?.from || !move?.to) return null;
  const fromX = Number(move.from.x ?? move.from.col);
  const fromY = Number(move.from.y ?? move.from.row);
  const toX = Number(move.to.x ?? move.to.col);
  const toY = Number(move.to.y ?? move.to.row);
  if (![fromX, fromY, toX, toY].every(Number.isInteger)) return null;
  return { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
}

function moveToUci(move) {
  if (!move) return '';
  return `${FILES[move.from.x]}${move.from.y}-${FILES[move.to.x]}${move.to.y}`;
}

function parseMove(value) {
  if (typeof value === 'object' && value?.from && value?.to) {
    return normalizeMoveCoordinates(value);
  }
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([a-i])([0-9])[-:]([a-i])([0-9])$/i);
  if (!match) return null;
  return {
    from: { x: FILES.indexOf(match[1].toLowerCase()), y: Number(match[2]) },
    to: { x: FILES.indexOf(match[3].toLowerCase()), y: Number(match[4]) },
  };
}

function legalMovesForBoard(board, side) {
  const legal = [];
  for (const move of generatePseudoMoves(board, side)) {
    const next = applyMoveToBoard(board, move);
    if (!isInCheck(next, side)) legal.push(move);
  }
  return legal;
}

// Convenience API for scene code using (row, col) instead of (x, y).
function getAllLegalMoves(board, side) {
  return legalMovesForBoard(board, normalizeSide(side)).map(withRowCol);
}

function getLegalMoves(board, row, col) {
  if (!inBounds(col, row)) return [];
  const piece = board[indexOf(col, row)];
  if (!piece) return [];
  return legalMovesForBoard(board, sideOf(piece))
    .filter((move) => move.from.x === col && move.from.y === row)
    .map(withRowCol);
}

function applyMove(board, moveLike) {
  const move = normalizeMoveCoordinates(moveLike);
  if (!move || !inBounds(move.from.x, move.from.y) || !inBounds(move.to.x, move.to.y)) {
    throw new TypeError('Move must contain valid from/to row+col or x+y coordinates');
  }
  const piece = board[indexOf(move.from.x, move.from.y)];
  if (!piece) throw new Error('Cannot move an empty square');
  return applyMoveToBoard(board, move);
}

function moveToNotation(moveLike) {
  const move = normalizeMoveCoordinates(moveLike);
  if (!move) return '';
  return `${FILES[move.from.x]}${move.from.y}-${FILES[move.to.x]}${move.to.y}`;
}

function positionalBonus(piece, x, y) {
  const side = sideOf(piece);
  const type = pieceType(piece);
  const forwardY = side === 'red' ? 9 - y : y;
  if (type === 'p') return crossedRiver(side, y) ? 35 + forwardY * 3 : forwardY * 2;
  if (type === 'n') return (3 - Math.abs(4 - x)) * 3;
  if (type === 'c') return (3 - Math.abs(4 - x)) * 2;
  if (type === 'r') return (3 - Math.abs(4 - x));
  return 0;
}

function evaluateBoard(board, perspective = 'red') {
  let score = 0;
  for (let i = 0; i < BOARD_SIZE; i += 1) {
    const piece = board[i];
    if (!piece) continue;
    const side = sideOf(piece);
    const value = PIECE_VALUES[pieceType(piece)] + positionalBonus(piece, xOf(i), yOf(i));
    score += side === perspective ? value : -value;
  }
  const enemy = opponent(perspective);
  if (isInCheck(board, enemy)) score += 28;
  if (isInCheck(board, perspective)) score -= 28;
  return score;
}

function orderMoves(moves) {
  return [...moves].sort((a, b) => {
    const captureA = a.captured ? PIECE_VALUES[pieceType(a.captured)] : 0;
    const captureB = b.captured ? PIECE_VALUES[pieceType(b.captured)] : 0;
    return captureB - captureA;
  });
}

function searchBestMove(board, side, depth, alpha, beta, rootSide) {
  const moves = legalMovesForBoard(board, side);
  if (depth <= 0 || moves.length === 0) {
    if (moves.length === 0) {
      if (isInCheck(board, side)) return { score: side === rootSide ? -999999 : 999999, move: null };
      return { score: 0, move: null };
    }
    return { score: evaluateBoard(board, rootSide), move: null };
  }

  const maximizing = side === rootSide;
  let bestScore = maximizing ? -Infinity : Infinity;
  let bestMove = null;
  for (const move of orderMoves(moves)) {
    const score = searchBestMove(applyMoveToBoard(board, move), opponent(side), depth - 1, alpha, beta, rootSide).score;
    if ((maximizing && score > bestScore) || (!maximizing && score < bestScore)) {
      bestScore = score;
      bestMove = move;
    }
    if (maximizing) {
      alpha = Math.max(alpha, bestScore);
    } else {
      beta = Math.min(beta, bestScore);
    }
    if (beta <= alpha) break;
  }
  return { score: bestScore, move: bestMove };
}

function chooseBestMove(gameOrBoard, options = {}) {
  const board = gameOrBoard instanceof XiangqiGame ? gameOrBoard.board : gameOrBoard;
  const side = normalizeSide(options.side || (gameOrBoard instanceof XiangqiGame ? gameOrBoard.turn : 'black'));
  const depth = Math.max(1, Math.min(3, Number(options.depth) || 2));
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) throw new TypeError('Expected a 90-square board');
  return searchBestMove(board, side, depth, -Infinity, Infinity, side).move;
}

class XiangqiGame {
  constructor(options = {}) {
    const initial = options.fen ? boardFromFen(options.fen) : null;
    this.board = initial ? initial.board : (options.board ? cloneBoard(options.board) : createInitialBoard());
    this.turn = normalizeSide(options.turn || (initial && initial.turn) || 'red');
    this.history = [];
    this.redoStack = [];
    this.moveNumber = 1;
    this.status = 'playing';
    this.lastMove = null;
    this._refreshStatus();
  }

  get fen() {
    return boardToFen(this.board, this.turn);
  }

  get currentSide() {
    return this.turn;
  }

  get gameOver() {
    return this.status !== 'playing';
  }

  clone() {
    const copy = new XiangqiGame({ board: this.board, turn: this.turn });
    copy.history = this.history.map((entry) => ({ before: cloneBoard(entry.before), move: cloneMove(entry.move), turn: entry.turn }));
    copy.redoStack = this.redoStack.map((entry) => ({ before: cloneBoard(entry.before), move: cloneMove(entry.move), turn: entry.turn }));
    copy.moveNumber = this.moveNumber;
    copy.status = this.status;
    copy.lastMove = this.lastMove ? cloneMove(this.lastMove) : null;
    return copy;
  }

  reset(options = {}) {
    const initial = options.fen ? boardFromFen(options.fen) : null;
    this.board = initial ? initial.board : createInitialBoard();
    this.turn = normalizeSide(options.turn || (initial && initial.turn) || 'red');
    this.history = [];
    this.redoStack = [];
    this.moveNumber = 1;
    this.lastMove = null;
    this.status = 'playing';
    this._refreshStatus();
    return this;
  }

  pieceAt(x, y) {
    return inBounds(x, y) ? this.board[indexOf(x, y)] : null;
  }

  isInCheck(side = this.turn) {
    return isInCheck(this.board, normalizeSide(side));
  }

  get legalMoves() {
    return legalMovesForBoard(this.board, this.turn);
  }

  legalMovesFrom(x, y) {
    return this.legalMoves.filter((move) => move.from.x === x && move.from.y === y);
  }

  canMove(moveLike) {
    const move = parseMove(moveLike);
    if (!move || !inBounds(move.from.x, move.from.y) || !inBounds(move.to.x, move.to.y)) return false;
    return this.legalMoves.some((candidate) => sameMove(candidate, move));
  }

  move(moveLike) {
    const requested = parseMove(moveLike);
    if (!requested) return { ok: false, reason: 'invalid-format', move: null };
    const legal = this.legalMoves.find((candidate) => sameMove(candidate, requested));
    if (!legal) {
      return { ok: false, reason: 'illegal-move', move: null, inCheck: this.isInCheck(this.turn) };
    }
    const before = cloneBoard(this.board);
    this.history.push({ before, move: cloneMove(legal), turn: this.turn });
    this.redoStack = [];
    this.board = applyMoveToBoard(this.board, legal);
    this.lastMove = cloneMove(legal);
    this.turn = opponent(this.turn);
    if (this.turn === 'red') this.moveNumber += 1;
    this._refreshStatus();
    return {
      ok: true,
      move: cloneMove(legal),
      captured: legal.captured,
      nextTurn: this.turn,
      status: this.status,
      check: this.isInCheck(this.turn),
    };
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return false;
    this.redoStack.push({ before: cloneBoard(this.board), move: cloneMove(entry.move), turn: this.turn });
    this.board = entry.before;
    this.turn = entry.turn;
    this.lastMove = this.history.length ? cloneMove(this.history[this.history.length - 1].move) : null;
    if (this.turn === 'red' && this.moveNumber > 1) this.moveNumber -= 1;
    this._refreshStatus();
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const move = this.legalMoves.find((candidate) => sameMove(candidate, entry.move));
    if (!move) {
      this.redoStack = [];
      return false;
    }
    this.history.push({ before: cloneBoard(this.board), move: cloneMove(move), turn: this.turn });
    this.board = applyMoveToBoard(this.board, move);
    this.lastMove = cloneMove(move);
    this.turn = opponent(this.turn);
    if (this.turn === 'red') this.moveNumber += 1;
    this._refreshStatus();
    return true;
  }

  aiMove(options = {}) {
    if (this.gameOver) return { ok: false, reason: 'game-over', move: null };
    const side = normalizeSide(options.side || this.turn);
    if (side !== this.turn) return { ok: false, reason: 'wrong-turn', move: null };
    const move = chooseBestMove(this, options);
    return move ? this.move(move) : { ok: false, reason: 'no-legal-moves', move: null };
  }

  _refreshStatus() {
    const moves = legalMovesForBoard(this.board, this.turn);
    if (moves.length === 0) {
      this.status = isInCheck(this.board, this.turn)
        ? `${opponent(this.turn)}-wins-checkmate`
        : 'draw-stalemate';
    } else {
      this.status = isInCheck(this.board, this.turn) ? 'check' : 'playing';
    }
    return this.status;
  }

  toJSON() {
    return {
      fen: this.fen,
      turn: this.turn,
      status: this.status,
      moveNumber: this.moveNumber,
      lastMove: this.lastMove ? cloneMove(this.lastMove) : null,
    };
  }
}

const API = {
  WIDTH,
  HEIGHT,
  BOARD_SIZE,
  FILES,
  PIECE_VALUES,
  PIECES,
  XiangqiGame,
  initialBoard,
  createInitialBoard,
  cloneBoard,
  boardToFen,
  boardFromFen,
  applyMoveToBoard,
  applyMove,
  getLegalMoves,
  getAllLegalMoves,
  legalMovesForBoard,
  generatePseudoMoves,
  isInCheck,
  findKing,
  sideOf,
  opponent,
  pieceType,
  inBounds,
  parseMove,
  moveToUci,
  moveToNotation,
  moveKey,
  sameMove,
  evaluateBoard,
  chooseBestMove,
};

// Expose a global for a plain browser script while retaining named ES exports.
if (typeof globalThis !== 'undefined') {
  globalThis.XiangqiGameLogic = Object.assign(globalThis.XiangqiGameLogic || {}, API);
}

export {
  WIDTH,
  HEIGHT,
  BOARD_SIZE,
  FILES,
  PIECE_VALUES,
  PIECES,
  XiangqiGame,
  initialBoard,
  createInitialBoard,
  cloneBoard,
  boardToFen,
  boardFromFen,
  applyMoveToBoard,
  applyMove,
  getLegalMoves,
  getAllLegalMoves,
  legalMovesForBoard,
  generatePseudoMoves,
  isInCheck,
  findKing,
  sideOf,
  opponent,
  pieceType,
  inBounds,
  parseMove,
  moveToUci,
  moveToNotation,
  moveKey,
  sameMove,
  evaluateBoard,
  chooseBestMove,
};

export default API;
