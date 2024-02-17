import {
	type AtpAgentLoginOpts,
	type AtpAgentOpts,
	AtpServiceClient,
	type AtpSessionData,
	AtUri,
	BskyAgent,
	type ComAtprotoServerCreateSession,
	type ComAtprotoServerGetSession,
	RichText,
} from "@atproto/api";
import { RateLimiter } from "limiter";
import { Post } from "./struct/post/Post";
import { PostPayload, type PostPayloadData } from "./struct/post/PostPayload";
import { Profile } from "./struct/Profile";
import { typedEntries, typedKeys } from "./util";

const NO_SESSION_ERROR = "Active session not found. Make sure to call the login method first.";

/**
 * Options for the Bot constructor
 */
interface BotOptions extends Partial<AtpAgentOpts> {
	/**
	 * The default list of languages to attach to posts
	 */
	langs?: Array<string>;

	/**
	 * The maximum number of requests that can be made to the Bluesky API in a given interval.
	 * Don't set this unless you know what you're doing.
	 * @default 3000
	 * @see https://www.docs.bsky.app/docs/advanced-guides/rate-limits
	 */
	rateLimit?: number;

	/**
	 * The interval after which the rate limit will reset, in seconds
	 * @default 300
	 * @see https://www.docs.bsky.app/docs/advanced-guides/rate-limits
	 */
	rateLimitInterval?: number;
}

/**
 * A bot that can interact with the Bluesky API
 */
export class Bot {
	/**
	 * The agent used to communicate with the Bluesky API
	 */
	agent: BskyAgent;

	limiter: RateLimiter;

	api: AtpServiceClient;

	/**
	 * The default list of languages to attach to posts
	 */
	langs: Array<string> = [];

	/**
	 * The bot account's Bluesky profile
	 */
	profile!: Profile;

	constructor({ langs, rateLimit = 3000, rateLimitInterval = 300, ...options }: BotOptions = {}) {
		this.agent = new BskyAgent({ service: "https://bsky.social", ...options });

		if (langs) this.langs = langs;

		this.limiter = new RateLimiter({
			tokensPerInterval: rateLimit,
			interval: rateLimitInterval * 1000,
		});

		this.api = this.agent.api;

		// Rate limit API methods by wrapping each method with a function that will remove a token from the limiter
		/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
		for (const namespace of [this.api.com.atproto, this.api.app.bsky]) {
			for (const collection of typedKeys(namespace)) {
				if (collection === "_service") continue;
				// @ts-expect-error — Hacky way to rate limit API methods
				for (const [methodName, method] of typedEntries(namespace[collection])) {
					if (methodName === "_service") continue;
					// @ts-expect-error — Hacky way to rate limit API methods
					namespace[collection][methodName] = async (input: unknown) => {
						// If there are 0 tokens remaining, this call will block until the interval resets
						await this.limiter.removeTokens(1);
						return method(input);
					};
				}
			}
		}
		/* eslint-enable @typescript-eslint/no-unsafe-member-access */
	}

	/**
	 * Log in with an identifier and password
	 * @param identifier The bot account's email, handle, or DID
	 * @param password The bot account's password
	 */
	async login(
		{ identifier, password }: AtpAgentLoginOpts,
	): Promise<ComAtprotoServerCreateSession.OutputSchema>;
	/**
	 * Log in with an existing session
	 * @param session Must have a valid refreshJwt and accessJwt
	 */
	async login(session: AtpSessionData): Promise<ComAtprotoServerGetSession.OutputSchema>;
	async login(
		options: AtpAgentLoginOpts | AtpSessionData,
	): Promise<
		ComAtprotoServerGetSession.OutputSchema | ComAtprotoServerCreateSession.OutputSchema
	> {
		let response;

		if ("accessJwt" in options && "refreshJwt" in options) {
			// Try resuming if session data is provided
			const resumeSessionResponse = await this.agent.resumeSession(options);
			if (!resumeSessionResponse.success) {
				throw new Error(
					"Provided session data is invalid, try logging in with identifier & password instead.",
				);
			}

			response = resumeSessionResponse.data;
		} else if ("identifier" in options && "password" in options) {
			// Try logging in with identifier & password
			if (options.identifier[0] === "@") {
				options.identifier = options.identifier.slice(1);
			}

			const loginResponse = await this.agent.login(options);
			if (!loginResponse.success) {
				throw new Error("Failed to log in — double check your credentials and try again.");
			}

			response = loginResponse.data;
		}

		if (!response) {
			throw new Error(
				"Invalid login options. You must provide either session data or an identifier & password.",
			);
		}

		this.profile = await this.getProfile(response.did).catch((e) => {
			throw new Error("Failed to fetch bot profile. Error:\n" + e);
		});

		return response;
	}

	/**
	 * Fetch a post by its AT URI
	 * @param uri The post's AT URI
	 */
	async getPost(uri: string): Promise<Post> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);

		await this.limiter.removeTokens(1);

		const { host: repo, rkey } = new AtUri(uri);
		const post = await this.agent.getPost({ repo, rkey });
		return new Post({
			...post.value,
			createdAt: new Date(post.value.createdAt),
			uri: post.uri,
			cid: post.cid,
			author: await this.getProfile(repo),
		});
	}

	/**
	 * Fetch a profile by its DID
	 * @param did The user's DID
	 */
	async getProfile(did: string): Promise<Profile> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);

		await this.limiter.removeTokens(1);

		const profile = await this.agent.getProfile({ actor: did });
		if (!profile.success) {
			throw new Error(`Failed to fetch profile ${did}\n` + JSON.stringify(profile.data));
		}
		return new Profile(profile.data);
	}

	/**
	 * Create a post
	 * @param data The post to create
	 * @param options Optional configuration
	 */
	async post(
		data: PostPayloadData,
		options: BotPostOptions = { resolveFacets: true },
	): Promise<Post> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);

		const post = new PostPayload(data);
		if (!post.langs?.length) post.langs = [...this.langs];

		const richText = new RichText({ text: post.text, facets: post.facets ?? [] });
		if (options.resolveFacets && !post.facets?.length) {
			await richText.detectFacets(this.agent);
		}

		const res = await this.api.com.atproto.repo.createRecord({
			collection: "app.bsky.feed.post",
			repo: this.profile.did,
			record: {
				...post,
				createdAt: post.createdAt.toISOString(),
				text: richText.text,
				facets: richText.facets ?? [],
			},
		});
		if (!res.success) {
			throw new Error("Failed to create post\n" + JSON.stringify(res.data));
		}

		return new Post({ ...data, ...res.data, author: this.profile });
	}
}

/**
 * Options for the Bot#post method
 */
interface BotPostOptions {
	/**
	 * Whether to automatically resolve facets in the post's text.
	 * This will be ignored if the provided post data already has facets attached
	 * @default true
	 */
	resolveFacets?: boolean;
}
