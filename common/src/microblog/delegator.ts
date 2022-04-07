import axios, { AxiosResponse } from 'axios'
import TID from '../repo/tid.js'

import { Post, Like, schema, Timeline, AccountInfo } from './types.js'
import * as check from '../common/check.js'
import { assureAxiosError, authCfg } from '../network/util.js'
import * as ucan from 'ucans'
import { Collection, Follow } from '../repo/types.js'
import { Keypair } from '../common/types.js'
import * as auth from '../auth/index.js'

export class MicroblogDelegator {
  programName = 'did:bsky:microblog'
  keypair: Keypair | null
  ucanStore: ucan.Store | null
  serverDid: string | null

  constructor(
    public url: string,
    public did: string,
    keypair?: Keypair,
    ucanStore?: ucan.Store,
  ) {
    this.keypair = keypair || null
    this.ucanStore = ucanStore || null
    this.serverDid = null
  }

  async getServerDid(): Promise<string> {
    if (!this.serverDid) {
      let did: string
      try {
        const res = await axios.get(`${this.url}/.well-known/did.json`)
        did = res.data.id
      } catch (e) {
        const err = assureAxiosError(e)
        throw new Error(`Could not retrieve server did ${err.message}`)
      }
      this.serverDid = did
    }
    return this.serverDid
  }

  async maintenanceToken(): Promise<ucan.Chained> {
    if (this.keypair === null || this.ucanStore === null) {
      throw new Error('No keypair or ucan store provided. Client is read-only.')
    }
    const serverDid = await this.getServerDid()
    return auth.delegateMaintenance(serverDid, this.keypair, this.ucanStore)
  }

  async relationshipToken(): Promise<ucan.Chained> {
    if (this.keypair === null || this.ucanStore === null) {
      throw new Error('No keypair or ucan store provided. Client is read-only.')
    }
    const serverDid = await this.getServerDid()
    return auth.delegateForRelationship(
      serverDid,
      this.did,
      this.keypair,
      this.ucanStore,
    )
  }

  async resolveDid(nameOrDid: string): Promise<string> {
    if (nameOrDid.startsWith('did:')) return nameOrDid
    const did = await this.lookupDid(nameOrDid)
    if (!did) {
      throw new Error(`Coult not find user: ${nameOrDid}`)
    }
    return did
  }

  async postToken(collection: Collection, tid: TID): Promise<ucan.Chained> {
    if (this.keypair === null || this.ucanStore === null) {
      throw new Error('No keypair or ucan store provided. Client is read-only.')
    }
    const serverDid = await this.getServerDid()
    return auth.delegateForPost(
      serverDid,
      this.did,
      this.programName,
      collection,
      tid,
      this.keypair,
      this.ucanStore,
    )
  }

  async register(username: string): Promise<void> {
    const data = { username, did: this.did }
    const token = await this.maintenanceToken()
    try {
      await axios.post(`${this.url}/id/register`, data, authCfg(token))
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async lookupDid(username: string): Promise<string | null> {
    const params = { resource: username }
    try {
      const res = await axios.get(`${this.url}/.well-known/webfinger`, {
        params,
      })
      return res.data.id
    } catch (e) {
      const err = assureAxiosError(e)
      if (err.response?.status === 404) {
        return null
      }
      throw new Error(err.message)
    }
  }

  async getAccountInfo(nameOrDid: string): Promise<AccountInfo | null> {
    const did = await this.resolveDid(nameOrDid)
    const params = { did }
    try {
      const res = await axios.get(`${this.url}/indexer/account-info`, {
        params,
      })
      return res.data
    } catch (e) {
      const err = assureAxiosError(e)
      if (err.response?.status === 404) {
        return null
      }
      throw new Error(err.message)
    }
  }

  async retrieveTimeline(count: number, from?: TID): Promise<Timeline> {
    const params = { user: this.did, count, from: from?.toString() }
    try {
      const res = await axios.get(`${this.url}/indexer/timeline`, { params })
      return res.data
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async getPost(tid: TID): Promise<Post | null> {
    return this.getPostFromUser(this.did, tid)
  }

  async getPostFromUser(nameOrDid: string, tid: TID): Promise<Post | null> {
    const did = await this.resolveDid(nameOrDid)
    const params = {
      tid: tid.toString(),
      did: did,
      program: this.programName,
    }
    let res: AxiosResponse
    try {
      res = await axios.get(`${this.url}/data/post`, { params })
    } catch (e) {
      const err = assureAxiosError(e)
      if (err.response?.status === 404) {
        return null
      }
      throw new Error(err.message)
    }
    if (!check.is(res.data, schema.post)) {
      throw new Error('Did not receive a valid post object')
    }
    return res.data
  }

  async addPost(text: string): Promise<Post> {
    const tid = TID.next()
    const post: Post = {
      tid: tid.toString(),
      program: this.programName,
      author: this.did,
      text,
      time: new Date().toISOString(),
    }
    const token = await this.postToken('posts', tid)
    try {
      await axios.post(`${this.url}/data/post`, post, authCfg(token))
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
    return post
  }

  async editPost(tid: TID, text: string): Promise<void> {
    const updated: Post = {
      tid: tid.toString(),
      program: this.programName,
      author: this.did,
      text,
      time: new Date().toISOString(),
    }
    const token = await this.postToken('posts', tid)
    try {
      await axios.put(`${this.url}/data/post`, updated, authCfg(token))
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async deletePost(tid: TID): Promise<void> {
    const data = {
      tid: tid.toString(),
      did: this.did,
      program: this.programName,
    }
    const token = await this.postToken('posts', tid)
    try {
      await axios.delete(`${this.url}/data/post`, {
        data,
        ...authCfg(token),
      })
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async listPosts(count: number, from?: TID): Promise<Post[]> {
    return this.listPostsFromUser(this.did, count, from)
  }

  async listPostsFromUser(
    nameOrDid: string,
    count: number,
    from?: TID,
  ): Promise<Post[]> {
    const did = await this.resolveDid(nameOrDid)
    const params = {
      did,
      program: this.programName,
      count,
      from: from?.toString(),
    }
    try {
      const res = await axios.get(`${this.url}/data/post/list`, {
        params,
      })
      return res.data
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async followUser(nameOrDid: string): Promise<void> {
    const did = await this.resolveDid(nameOrDid)
    const data = { creator: this.did, target: did }
    const token = await this.relationshipToken()
    try {
      await axios.post(`${this.url}/data/relationship`, data, authCfg(token))
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async unfollowUser(nameOrDid: string): Promise<void> {
    const did = await this.resolveDid(nameOrDid)
    const data = { creator: this.did, target: did }
    const token = await this.relationshipToken()
    try {
      await axios.delete(`${this.url}/data/relationship`, {
        data,
        ...authCfg(token),
      })
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async listFollows(): Promise<Follow[]> {
    return this.listFollowsFromUser(this.did)
  }

  async listFollowsFromUser(nameOrDid: string): Promise<Follow[]> {
    const did = await this.resolveDid(nameOrDid)
    const params = { user: did }
    try {
      const res = await axios.get(`${this.url}/data/relationship/list`, {
        params,
      })
      return res.data
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async listFollowers(): Promise<Follow[]> {
    return this.listFollowersForUser(this.did)
  }

  async listFollowersForUser(nameOrDid: string): Promise<Follow[]> {
    const did = await this.resolveDid(nameOrDid)
    const params = { user: did }
    try {
      const res = await axios.get(`${this.url}/indexer/followers`, {
        params,
      })
      return res.data
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async likePost(postAuthorNameOrDid: string, postTid: TID): Promise<Like> {
    const postAuthorDid = await this.resolveDid(postAuthorNameOrDid)
    const tid = TID.next()
    const like: Like = {
      tid: tid.toString(),
      program: this.programName,
      author: this.did,
      time: new Date().toISOString(),
      post_tid: postTid.toString(),
      post_author: postAuthorDid,
      post_program: this.programName,
    }
    const token = await this.postToken('interactions', tid)
    try {
      await axios.post(`${this.url}/data/interaction`, like, authCfg(token))
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
    return like
  }

  async deleteLike(likeTid: TID): Promise<void> {
    const data = {
      tid: likeTid.toString(),
      did: this.did,
      program: this.programName,
    }
    const token = await this.postToken('interactions', likeTid)
    try {
      await axios.delete(`${this.url}/data/interaction`, {
        data,
        ...authCfg(token),
      })
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async unlikePost(authorNameOrDid: string, postTid: TID): Promise<void> {
    const like = await this.getLikeByPost(authorNameOrDid, postTid)
    if (like === null) {
      throw new Error('Like does not exist')
    }
    await this.deleteLike(TID.fromStr(like.tid))
  }

  async getLikeByPost(
    authorNameOrDid: string,
    postTid: TID,
  ): Promise<Like | null> {
    const authorDid = await this.resolveDid(authorNameOrDid)
    const params = {
      did: this.did,
      postAuthor: authorDid,
      postProgram: this.programName,
      postTid: postTid.toString(),
    }
    try {
      const res = await axios.get(`${this.url}/data/interaction`, { params })
      return res.data
    } catch (e) {
      const err = assureAxiosError(e)
      if (err.response?.status === 404) {
        return null
      }
      throw new Error(err.message)
    }
  }

  async listLikes(count: number, from?: TID): Promise<Like[]> {
    return this.listLikesFromUser(this.did, count, from)
  }

  async listLikesFromUser(
    nameOrDid: string,
    count: number,
    from?: TID,
  ): Promise<Like[]> {
    const did = await this.resolveDid(nameOrDid)
    const params = {
      did,
      program: this.programName,
      count,
      from: from?.toString(),
    }
    try {
      const res = await axios.get(`${this.url}/data/interaction/list`, {
        params,
      })
      return res.data
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }

  async likeCount(author: string, tid: TID): Promise<number> {
    const params = {
      author,
      program: this.programName,
      tid: tid.toString(),
    }
    try {
      const res = await axios.get(`${this.url}/indexer/count/likes`, {
        params,
      })
      return res.data.count
    } catch (e) {
      const err = assureAxiosError(e)
      throw new Error(err.message)
    }
  }
}

export default MicroblogDelegator
