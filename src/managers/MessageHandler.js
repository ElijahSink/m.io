var Player = require('../entities/Player');
var log = require('../utils/Logger');
const Utils = require('../utils/Utils');
const PACKET = require('../utils/packetCodes');
var Axe = require('../weapon/Axe');
var Sword = require('../weapon/Sword');
var Items = require('../utils/Items');

class MessageHandler {
	checkConnection(socket) {
		var me = this;
		if (!socket || !socket.player)
				return false;
		if (!socket.player.connected) {
			me.manager.close(socket, 'Connection handshake not completed.');
		}
		return socket.player.connected;
	}
	conn(socket) {
		var me = this;
		if (socket.player.connected) {
			// For some reason the client sent a connection packet while already connected
			this.manager.close(socket, 'Invalid connection');
		} else if (this.manager.players.length >
					this.config.maxPlayers) {
			// Server is full
			me.manager.close(socket, `
					<h1 style="font-size: 150%; color: red">
						Server is full.
					</h1>`);
		} else {
			// The client is now connected
			socket.player.connected = true;
			// Update the player's time
			this.manager.updateTime(socket);
		}
	}
	disconn(socket) {
		log.all('Player disconnected,', socket.player.name);
		this.io.emit(PACKET.PLAYER_REMOVE, 
																			socket.player.id);
		this.manager.remove(socket);
	}
	angle(socket, ang) {
		// Player angle update
		if (socket.player.connected)
			socket.player.angle = ang;
	}
	move(socket, key, down) {
		if (socket.player.connected && key && typeof down === "number") {
			// The player has sent a valid move packet
			var boolDown = !!down;
			switch (key) {
				case "u":
				case "d":
					socket.player.dirY = key;
					socket.player.downY = boolDown;
					break;
				case "l":
				case "r":
					socket.player.dirX = key;
					socket.player.downX = boolDown;
					break;
			}
		}
	}
	autoAttack(socket) {
		log.all("Player " + socket.player.name + " has toggled auto attack");
		socket.player.autoAtk = !socket.player.autoAtk;
	}
	chat(socket, msg) {
		// Player chat recieved
		for (var i = 0; i < socket.player.playersNear.length; ++i) {
			this.manager.sendChat(socket, socket.player.playersNear[i], msg);
		}
	}
	syncClanPlayers(socket) {
		var data = socket.player.clan.serializeMembers();
		socket.emit(PACKET.SET_CLAN_PLAYERS, data);
	}
	deleteClan(clan) {
		this.io.emit(PACKET.CLAN_DEL, clan.name);
		this.clans.remove(clan.name);
	}
	attemptBuy(socket, isBuying, id) {
		var item = this.store.getItemById(id);
		if (isBuying && id) {
			log.all(socket.player.name + " attempted to buy item " + id);
			if (this.store.canBuyItem(socket, item)) {
				socket.player.addHat(item);
				this.manager.updateStore(socket, 0, item.id);
				log.all(socket.player.name + ' has purchased item ' + item.id);
			} else {
				// The player can't buy this item
				log.all(socket.player.name + ' can\'t purchase item ' + item.id);
			}
		} else if (!isBuying) {
			if (socket.player.hasHat(id)) {
				log.all(socket.player.name + " is equipting hat " + id);
				var i = socket.player.getHat(id);
				socket.player.equiptHat(i);
				this.manager.updateStore(socket, 1, item.id);
			} else if (id === 0) {
				// Player unequipted their hat
				this.manager.updateStore(socket, 1, 0);
				socket.player.unequipt();
			} else {
				this.manager.close(socket, "Bad equipt packet");
			}
		} else {
			// Invalid ID, close connection
			this.manager.close(socket, "Bad shop packet");
		}
	}
	notificationResponse(socket, sid, join) {
		var p = this.manager.getBySID(sid);
		if (!p) {
			log.all("Not adding non existent clan member");
		} else if (p.player.joiningClan) {
			p.player.joiningClan = false;
			if (join) {
				// Player can join the clan
				log.all(p.player.name + " has joined clan " + socket.player.clan.name);
				socket.player.clan.addPlayer(p);
				p.emit(PACKET.PLAYER_SET_CLAN, socket.player.team, 0);
				for (var i = 0; i < socket.player.clan.members.length; ++i) {
					this.msgHandler.syncClanPlayers(socket.player.clan.members[i]);
				}
			}
		}
	}
	doUpgrade(socket, id) {
		console.log(socket.player.name + ' tried to upgrade with id ' + id);
		var age = socket.player.age;
		var pts = socket.player.upgradePoints;
		if (pts < 1) {
			return this.manager.close(socket, "Bad upgrade points");
		}
		switch (pts) {
			case 1:
				if (id == 1) {
					// Player chose the axe
					socket.player.setWeapon(new Axe);
				} else if (id == 2) {
					socket.player.setWeapon(new Sword);
				} else {
					return this.manager.close(socket, "Invalid upgrade ID");
				}
				break;
			case 2:
				// TODO: handle later upgrades
				break;
		}
		socket.player.upgradePoints--;
		this.manager.syncPlayerItems(socket);
		if (socket && socket.player.upgradePoints == 0) {
			this.manager.hideUpgrades(socket);
		}
	}
	attack(socket, atk, buildDir) {
		var me = this;
		if (socket.player.alive) {
			if (socket.player.buildCode === -1) {
				socket.player.attacking = !!atk; // Regular attack
			} else {
				// Player is attempting to build something
				socket.player.useCurrentItem();
			}
		}
	}
	clanKick(socket, sid) {
		var p = this.manager.getBySID(sid);
		if (p && socket.player.clan) {
			socket.player.clan.removePlayer(p);
			for (var i = 0; i < socket.player.clan.members.length; ++i) {
				this.msgHandler.syncClanPlayers(socket.player.clan.members[i]);
			}
		}
	}
	clanJoin(socket, sid) {
		var clan = this.clans.getByName(sid);
		if (clan) {
			// Send an join notification to the owner
			var sid = socket.player.sid;
			var name = socket.player.name;
			socket.player.joiningClan = true;
			clan.owner.emit(PACKET.CLAN_NOTIFY, sid, name);
		}
	}
	clanLeave(socket) {
		if (socket.player.team) {
			// It's safe to remove the player's clan
			log.all('Player "' + socket.player.name + "\" is leaving their clan " + socket.player.team);
			if (socket.player.clan.isPlayerOwner(socket)) {
				this.msgHandler.deleteClan.call(this, socket.player.clan);
			}
			for (var i = 0; i < socket.player.clan.members.length; ++i) {
				this.msgHandler.syncClanPlayers(socket.player.clan.members[i]);
			}
			socket.player.clan.removePlayer(socket);
		}
	}
	clanCreate(socket, clanName) {
		if (!this.clans.clanExists(clanName)) {
			// It's safe to add the clan
			this.clans.add(clanName);
			var newClanData = this.clans.newestClan.serialize();
			this.clans.newestClan.addPlayer(socket);
			// Broadcast the creation of a new clan
			this.io.emit(PACKET.CLAN_ADD, newClanData);
			// Set the player's clan to the new clan
			socket.emit(PACKET.PLAYER_SET_CLAN, newClanData.sid, 1);
			this.msgHandler.syncClanPlayers(socket);
			log.all("Clan '" + clanName + "' has been created by " + socket.player.name);
		}
	}
	spawn(socket, data) {
		var me = this;
		if (!this.msgHandler.checkConnection.call(me, socket))
			return;
		// Player can spawn, update their name
		var name = data.name.trim();
		if (name === "") 
			name = this.config.unknownName;
		socket.player.name = name;
		// Update player coords. This will be better eventually
		socket.player.x = Utils.rand(this.config.mapSize);
		socket.player.y = Utils.rand(this.config.mapSize);
		if (!socket.player.spawned) {
			// New players get an empty update packet
			socket.player.spawned = true;
			for (var i = 0; i < me.clans.clans.length; ++i) {
				socket.emit(PACKET.CLAN_ADD, me.clans.clans[i].serialize());
			}
		} else {
			// Player is respawning
			socket.player.resetPlayer(me.config.saveStats);
		}
		setTimeout(() => {
			me.manager.sendRawUpdate(socket, []);
			log.all("Spawned player with name", socket.player.name);
			socket.player.alive = true;
			me.manager.updateHealth(socket);
			socket.emit(PACKET.UPDATE_HEALTH,
						socket.player.sid,
						socket.player.health);
			me.manager.sendStart(socket);
			// Send player data to player
			me.manager.addSelfPlayer(socket);
		}, 10);
	}
	select(socket, index, isWeapon) {
		var me = this;
		log.all(socket.player.name + " has selected item " + index);
		if (isWeapon) {
			if (socket.player.weapons.includes(index)) {
				socket.player.weaponCode = index;
			} else {
				return me.manager.close(socket, "Invalid weapon code");
			}
		} else {
			if (index === socket.player.buildCode) {
				socket.player.buildCode = -1;
			} else if (socket.player.items.includes(index)) {
				var item = Items.items[index];
				if (item) {
					if (socket.player.canBuild(item)) {
						item.build(socket);
					}
				} else {
					return me.manager.close(socket, "Invalid item");
				}
			}
		}
		me.manager.updateMaterials(socket);
	}
	constructor(gameServer) {
		this.gameServer = gameServer;
	}
}
module.exports = MessageHandler;