import { Connection, PersistentConnection, WebSocketConnection } from '@d-fischer/connection';
import { Logger, LogLevel } from '@d-fischer/logger';
import { Enumerable, ResolvableValue } from '@d-fischer/shared-utils';
import { EventEmitter, Listener } from '@d-fischer/typed-event-emitter';
import { AuthProvider, HellFreezesOverError, InvalidTokenError } from 'twitch';
import { getTokenInfo } from 'twitch-auth';
import { PubSubMessageData } from './Messages/PubSubMessage';
import { PubSubIncomingPacket, PubSubNoncedOutgoingPacket, PubSubOutgoingPacket } from './PubSubPacket';

interface NullTokenResolvable {
	type: 'null';
}

interface StaticTokenResolvable {
	type: 'static';
	token: string;
}

interface FunctionTokenResolvable {
	type: 'function';
	function: () => string | Promise<string>;
}

interface ProviderTokenResolvable {
	type: 'provider';
	provider: AuthProvider;
	scopes: string[];
}

type TokenResolvable = NullTokenResolvable | StaticTokenResolvable | FunctionTokenResolvable | ProviderTokenResolvable;

/**
 * A client for the Twitch PubSub interface.
 */
export class BasicPubSubClient extends EventEmitter {
	@Enumerable(false) private readonly _logger: Logger;

	// topic => token
	@Enumerable(false) private readonly _topics = new Map<string, TokenResolvable>();

	private _connection: Connection;

	private _pingOnInactivity: number = 60;
	private _pingTimeout: number = 60;
	private _pingCheckTimer?: NodeJS.Timer;
	private _pingTimeoutTimer?: NodeJS.Timer;

	private readonly _onPong: (handler: () => void) => Listener = this.registerEvent();
	private readonly _onResponse: (handler: (nonce: string, error: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a message that matches your listening topics is received.
	 *
	 * @eventListener
	 * @param topic The name of the topic.
	 * @param message The message data.
	 */
	readonly onMessage: (
		handler: (topic: string, message: PubSubMessageData) => void
	) => Listener = this.registerEvent();

	/**
	 * Fires when the client finishes establishing a connection to the PubSub server.
	 *
	 * @eventListener
	 */
	readonly onConnect: (handler: () => void) => Listener = this.registerEvent();

	/**
	 * Fires when the client closes its connection to the PubSub server.
	 *
	 * @eventListener
	 * @param isError Whether the cause of the disconnection was an error. A reconnect will be attempted if this is true.
	 */
	readonly onDisconnect: (handler: (isError: boolean, reason?: Error) => void) => Listener = this.registerEvent();

	/**
	 * Fires when the client receives a pong message from the PubSub server.
	 *
	 * @eventListener
	 * @param latency The current latency to the server, in milliseconds.
	 * @param requestTimestampe The time the ping request was sent to the PubSub server.
	 */
	readonly onPong: (handler: (latency: number, requestTimestamp: number) => void) => Listener = this.registerEvent();

	/**
	 * Creates a new PubSub client.
	 *
	 * @param logLevel The level of logging to use for the PubSub client.
	 */
	constructor(logLevel: LogLevel = LogLevel.WARNING) {
		super();
		this._logger = new Logger({
			name: 'twitch-pubsub-client',
			emoji: true,
			minLevel: logLevel
		});

		this._connection = new PersistentConnection(
			WebSocketConnection,
			{ hostName: 'pubsub-edge.twitch.tv', port: 443, secure: true },
			{ logger: this._logger }
		);

		this._connection.onConnect(async () => {
			try {
				this._logger.info('Connection established');
				await this._resendListens();
				if (this._topics.size) {
					this._logger.info('Listened to previously registered topics');
					this._logger.debug(`Previously registered topics: ${Array.from(this._topics.keys()).join(', ')}`);
				}
				this._startPingCheckTimer();
				this.emit(this.onConnect);
			} catch (error) {
				this.emit(this.onDisconnect, false, error);
			}
		});

		this._connection.onReceive((line: string) => {
			this._receiveMessage(line);
			this._startPingCheckTimer();
		});

		this._connection.onDisconnect((manually: boolean, reason?: Error) => {
			if (this._pingCheckTimer) {
				clearTimeout(this._pingCheckTimer);
			}
			if (this._pingTimeoutTimer) {
				clearTimeout(this._pingTimeoutTimer);
			}
			if (manually) {
				this._logger.info('Disconnected');
			} else {
				if (reason) {
					this._logger.err(`Disconnected unexpectedly: ${reason.message}`);
				} else {
					this._logger.err('Disconnected unexpectedly');
				}
			}
			this.emit(this.onDisconnect, manually, reason);
		});
	}

	/**
	 * Listens to one or more topics.
	 *
	 * @param topics A topic or a list of topics to listen to.
	 * @param tokenResolvable An access token, an AuthProvider or a function that returns a token.
	 * @param scope The scope necessary for the topic(s).
	 */
	async listen(
		topics: string | string[],
		tokenResolvable?: ResolvableValue<string> | AuthProvider | TokenResolvable | null,
		scope?: string
	) {
		if (typeof topics === 'string') {
			topics = [topics];
		}

		const wrapped = this._wrapResolvable(tokenResolvable, scope);
		for (const topic of topics) {
			this._topics.set(topic, wrapped);
		}

		if (this.isConnected) {
			await this._sendListen(topics, await this._resolveToken(wrapped));
		}
	}

	/**
	 * Removes one or more topics from the listener.
	 *
	 * @param topics A topic or a list of topics to not listen to anymore.
	 */
	async unlisten(topics: string | string[]) {
		if (typeof topics === 'string') {
			topics = [topics];
		}

		for (const topic of topics) {
			this._topics.delete(topic);
		}

		if (this.isConnected) {
			await this._sendUnlisten(topics);
		}
	}

	/**
	 * Connects to the PubSub interface.
	 */
	async connect() {
		if (!this._connection.isConnected && !this._connection.isConnecting) {
			this._logger.info('Connecting...');
			await this._connection.connect();
		}
	}

	/**
	 * Disconnects from the PubSub interface.
	 */
	async disconnect() {
		this._logger.info('Disconnecting...');
		return this._connection.disconnect();
	}

	/**
	 * Reconnects to the PubSub interface.
	 */
	async reconnect() {
		await this.disconnect();
		return this.connect();
	}

	/**
	 * Checks whether the client is currently connecting to the server.
	 */
	get isConnecting() {
		return this._connection?.isConnecting ?? false;
	}

	/**
	 * Checks whether the client is currently connected to the server.
	 */
	get isConnected() {
		return this._connection?.isConnected ?? false;
	}

	/** @private */
	get hasAnyTopics() {
		return this._topics.size > 0;
	}

	private async _sendListen(topics: string[], accessToken?: string) {
		return this._sendNonced({
			type: 'LISTEN',
			data: {
				topics,
				auth_token: accessToken
			}
		});
	}

	private async _sendUnlisten(topics: string[]) {
		return this._sendNonced({
			type: 'UNLISTEN',
			data: {
				topics
			}
		});
	}

	private _wrapResolvable(
		resolvable?: ResolvableValue<string> | AuthProvider | TokenResolvable | null,
		scope?: string
	): TokenResolvable {
		switch (typeof resolvable) {
			case 'object': {
				if (resolvable === null) {
					return {
						type: 'null'
					};
				}
				if ('type' in resolvable) {
					return resolvable;
				}
				return {
					type: 'provider',
					provider: resolvable,
					scopes: scope ? [scope] : []
				};
			}
			case 'string': {
				return {
					type: 'static',
					token: resolvable
				};
			}
			case 'function': {
				return {
					type: 'function',
					function: resolvable
				};
			}
			case 'undefined': {
				return {
					type: 'null'
				};
			}
			default: {
				throw new HellFreezesOverError(`Passed unknown type to wrapResolvable: ${typeof resolvable}`);
			}
		}
	}

	private async _resolveToken(resolvable: TokenResolvable): Promise<string | undefined> {
		switch (resolvable.type) {
			case 'provider': {
				const { provider, scopes } = resolvable;
				let lastTokenError: InvalidTokenError | undefined = undefined;

				try {
					const accessToken = await provider.getAccessToken(scopes);
					if (accessToken) {
						// check validity
						await getTokenInfo(accessToken.accessToken);
						return accessToken.accessToken;
					}
				} catch (e) {
					if (e instanceof InvalidTokenError) {
						lastTokenError = e;
					} else {
						this._logger.err(`Retrieving an access token failed: ${e.message}`);
					}
				}

				this._logger.warning('No valid token available; trying to refresh');

				if (provider.refresh) {
					try {
						const newToken = await provider.refresh();

						if (newToken) {
							// check validity
							await getTokenInfo(newToken.accessToken);
							return newToken.accessToken;
						}
					} catch (e) {
						if (e instanceof InvalidTokenError) {
							lastTokenError = e;
						} else {
							this._logger.err(`Refreshing the access token failed: ${e.message}`);
						}
					}
				}

				throw lastTokenError || new Error('Could not retrieve a valid token');
			}
			case 'function': {
				return resolvable.function();
			}
			case 'static': {
				return resolvable.token;
			}
			case 'null': {
				return undefined;
			}
			default: {
				throw new HellFreezesOverError(
					`Passed unknown type to resolveToken: ${(resolvable as TokenResolvable).type}`
				);
			}
		}
	}

	private async _resendListens() {
		const topicsByTokenResolvable = new Map<TokenResolvable, string[]>();
		for (const [topic, tokenResolvable] of this._topics) {
			if (topicsByTokenResolvable.has(tokenResolvable)) {
				topicsByTokenResolvable.get(tokenResolvable)!.push(topic);
			} else {
				topicsByTokenResolvable.set(tokenResolvable, [topic]);
			}
		}
		const topicsByToken = new Map<string | undefined, string[]>();
		for (const [tokenResolvable, topics] of topicsByTokenResolvable) {
			const token = await this._resolveToken(tokenResolvable);
			if (topicsByToken.has(token)) {
				topicsByToken.get(token)!.push(...topics);
			} else {
				topicsByToken.set(token, topics);
			}
		}
		return Promise.all(
			Array.from(topicsByToken.entries()).map(async ([token, topics]) => this._sendListen(topics, token))
		);
	}

	private async _sendNonced<T extends PubSubNoncedOutgoingPacket>(packet: T) {
		return new Promise<void>((resolve, reject) => {
			const nonce = Math.random().toString(16).slice(2);

			this._onResponse((recvNonce, error) => {
				if (recvNonce === nonce) {
					if (error) {
						reject(new Error(`Error sending nonced ${packet.type} packet: ${error}`));
					} else {
						resolve();
					}
				}
			});

			packet.nonce = nonce;

			this._sendPacket(packet);
		});
	}

	private _receiveMessage(dataStr: string) {
		this._logger.debug(`Received message: ${dataStr}`);
		const data: PubSubIncomingPacket = JSON.parse(dataStr);

		switch (data.type) {
			case 'PONG': {
				this.emit(this._onPong);
				break;
			}
			case 'RECONNECT': {
				// tslint:disable-next-line:no-floating-promises
				this.reconnect();
				break;
			}
			case 'RESPONSE': {
				this.emit(this._onResponse, data.nonce, data.error);
				break;
			}
			case 'MESSAGE': {
				this.emit(this.onMessage, data.data.topic, JSON.parse(data.data.message));
				break;
			}
			default: {
				this._logger.warn(
					`PubSub connection received unexpected message type: ${(data as PubSubIncomingPacket).type}`
				);
			}
		}
	}

	private _sendPacket(data: PubSubOutgoingPacket) {
		const dataStr = JSON.stringify(data);
		this._logger.debug(`Sending message: ${dataStr}`);
		this._connection.sendLine(dataStr);
	}

	private _pingCheck() {
		const pingTime = Date.now();
		const pongListener = this._onPong(() => {
			const latency = Date.now() - pingTime;
			this.emit(this.onPong, latency, pingTime);
			this._logger.info(`Current latency: ${latency}ms`);
			if (this._pingTimeoutTimer) {
				clearTimeout(this._pingTimeoutTimer);
			}
			this.removeListener(pongListener);
		});
		this._pingTimeoutTimer = setTimeout(async () => {
			this._logger.err('Ping timeout');
			this.removeListener(pongListener);
			return this.reconnect();
		}, this._pingTimeout * 1000);
		this._sendPacket({ type: 'PING' });
	}

	private _startPingCheckTimer() {
		if (this._pingCheckTimer) {
			clearInterval(this._pingCheckTimer);
		}
		this._pingCheckTimer = setInterval(() => this._pingCheck(), this._pingOnInactivity * 1000);
	}
}
