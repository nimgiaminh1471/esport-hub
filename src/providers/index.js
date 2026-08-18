/**
 * Registry provider cho phía Node.
 *
 * Registry thật nằm ở `docs/assets/games.js` — cùng chỗ với các file core, vì đó
 * là thư mục duy nhất mà cả ba mặt (Node, Worker, browser) đều với tới được.
 * File này chỉ re-export để `src/` giữ nguyên đường import quen thuộc.
 *
 * Định nghĩa interface của một provider và hướng dẫn thêm game mới: xem comment
 * đầu `docs/assets/games.js`.
 */
export {
  providers,
  DEFAULT_GAME,
  getProvider,
  resolveGame,
  default as default,
} from '../../docs/assets/games.js';
