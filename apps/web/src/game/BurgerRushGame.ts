import Phaser from 'phaser';

type GameAction = 'LEFT' | 'RIGHT' | 'JUMP' | 'ATTACK';

export function createBurgerRushGame(container: HTMLElement) {
  class ArenaScene extends Phaser.Scene {
    private players = new Map<string, Phaser.GameObjects.Rectangle>();
    private ingredient?: Phaser.GameObjects.Arc;
    private elapsed = 0;

    constructor() { super('arena'); }

    create() {
      this.cameras.main.setBackgroundColor('#171b18');
      this.add.rectangle(450, 250, 860, 4, 0xf4b942);
      this.ingredient = this.add.circle(500, 220, 14, 0x68a357).setStrokeStyle(3, 0xf7f4ec);
      this.add.text(32, 24, 'BURGER RUSH', { fontFamily: 'Space Grotesk', fontSize: '24px', color: '#f4b942' });
      this.add.text(32, 58, 'La arena está en vivo', { fontFamily: 'DM Mono', fontSize: '14px', color: '#c6cabb' });
    }

    update(_time: number, delta: number) {
      this.elapsed += delta;
      for (const sprite of this.players.values()) sprite.y = 220 + Math.sin(this.elapsed / 250 + sprite.x) * 4;
    }

    setIngredientPosition(x: number) { this.ingredient?.setX(x); }

    syncPlayers(players: Array<{ id: string; x: number; y: number }>) {
      for (const player of players) {
        const sprite = this.players.get(player.id);
        if (sprite) { sprite.x = player.x; sprite.y = player.y; }
      }
    }

    addPlayer(playerId: string, seat: number, nickname: string) {
      if (this.players.has(playerId)) return;
      const color = [0xf4b942, 0x68a357, 0xe7774f, 0x6da9d8][(seat - 1) % 4];
      const x = 120 + ((seat - 1) % 4) * 220;
      const sprite = this.add.rectangle(x, 220, 46, 46, color).setStrokeStyle(2, 0xf7f4ec);
      this.add.text(x - 45, 285, nickname, { fontFamily: 'Space Grotesk', fontSize: '16px', color: '#f7f4ec' });
      this.players.set(playerId, sprite);
    }

    applyInput(playerId: string, action: GameAction) {
      const sprite = this.players.get(playerId);
      if (!sprite) return;
      if (action === 'LEFT') sprite.x = Math.max(80, sprite.x - 28);
      if (action === 'RIGHT') sprite.x = Math.min(820, sprite.x + 28);
      if (action === 'JUMP') this.tweens.add({ targets: sprite, y: 130, duration: 180, yoyo: true });
      if (action === 'ATTACK') this.tweens.add({ targets: sprite, scaleX: 1.45, duration: 120, yoyo: true });
    }
  }

  const game = new Phaser.Game({ type: Phaser.AUTO, width: 900, height: 500, parent: container, scene: ArenaScene, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH } });
  return { game, scene: () => game.scene.getScene('arena') as ArenaScene };
}