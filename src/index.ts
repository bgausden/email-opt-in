/* email-opt-in */

/* Run from PS command-line: $env:DEBUG="*,-getClients"; node .\dist\index.js */

// TODO #3 add progress meter

import fetch, { Headers } from "node-fetch"
import { URLSearchParams } from "url"
import fs from "fs"
import readline from "readline"
import { BackoffError, RequestRateLimiter } from "request-rate-limiter"
import debug from "debug"
import { env, loadEnv } from './env.js'
loadEnv()

const MB_API_BASE_URL = env.MB_API_BASE_URL
const MB_API_TEST_FLAG = env.MB_API_TEST_FLAG

const API_TOKEN = env.API_TOKEN
const SITE_ID = env.SITE_ID
const SITEOWNER = env.SITEOWNER
const PASSWORD = env.PASSWORD

const MAX_CLIENTS_TO_PROCESS = env.MAX_CLIENTS_TO_PROCESS
const MAX_CLIENT_REQ = Math.min(env.MAX_CLIENT_REQ, MAX_CLIENTS_TO_PROCESS)

const BAD_CLIENTS = env.BAD_CLIENTS
const REVIEW_CLIENTS = env.REVIEW_CLIENTS

const AUDIENCE_CSV = env.AUDIENCE_CSV
const CSV_HAS_HEADER = env.CSV_HAS_HEADER
const EMAIL_COLUMN = env.EMAIL_COLUMN

const LIMITER_BACKOFFTIME = Math.max(env.LIMITER_BACKOFFTIME,10)
const MAX_REQUEST_RATE = Math.min(env.MAX_REQUEST_RATE, 1000)
const REQUEST_RATE_INTERVAL = Math.min(env.REQUEST_RATE_INTERVAL, 60)
const LIMITER_TIMEOUT = env.LIMITER_TIMEOUT

type NullableString = string | null

interface Client {
    HomePhone: NullableString
    WorkPhone: NullableString
    MobilePhone: NullableString
    Id: string
    FirstName: string
    LastName: NullableString
    Email: NullableString
    Action?: string
    Notes: NullableString
}

interface MBError {
    Message: string
    Code: string
}

interface WrappedClient {
    Client: Client
}

interface WrappedMBError {
    Error: MBError
}

type updateClientResult = WrappedClient | WrappedMBError

interface RequestConfig {
    url: RequestInfo
    init: RequestInit
}

interface updateClientsResult {
    optedInClients: number
    optedOutClients: number
    updateFailedClients: number
}

export class cloneable {
    public static deepCopy<T>(source: T): T {
        return Array.isArray(source)
            ? source.map(item => this.deepCopy(item))
            : source instanceof Date
                ? new Date(source.getTime())
                : source && typeof source === 'object'
                    ? Object.getOwnPropertyNames(source).reduce((o, prop) => {
                        const propDesc = Object.getOwnPropertyDescriptor(source, prop)
                        Object.defineProperty(o, prop, propDesc!);
                        o[prop] = this.deepCopy(((source as unknown) as { [index: string]: T })[prop]);
                        return o;
                    }, Object.create(Object.getPrototypeOf(source)))
                    : source;
    }
}


/*
This class is supposed to implement the use of fetch to access data instead
of the request-rate-limiter built-in implemenation that used request (now deprecated)
Can probably be ignored so we don't have to deal with passing options in request-form to
fetch (which expects them in fetch-form)
*/
class fetchRequestHandler {
    // eslint-disable-next-line no-unused-vars
    constructor(public backoffCode: number = 429) { }
    async request(requestConfig: any) {
        const url = requestConfig.url
        const init = requestConfig.init
        const response = await fetch(url, init)
        if (response.status === this.backoffCode) {
            mainDebug(`\nWorker backing off for 10s`)
            throw new BackoffError(`${response.statusText}`)
        } else return response
    }
}

/**
 * Simple Utility Methods for checking information about a value.
 *
 * @param  {Mixed}  value  Could be anything.
 * @return {Object}
 */
// eslint-disable-next-line no-unused-vars
function is(value: any) {
    return {
        a: function (check: any) {
            if (check.prototype) check = check.prototype.constructor.name
            const type: string = Object.prototype.toString
                .call(value)
                .slice(8, -1)
                .toLowerCase()
            return value != null && type === check.toLowerCase()
        },
    }
}

function initLimiter(
    backoffTime = LIMITER_BACKOFFTIME,
    requestRate = MAX_REQUEST_RATE,
    interval = REQUEST_RATE_INTERVAL,
    timeout = LIMITER_TIMEOUT
) {
    mainDebug(
        `Rate limiting to ${requestRate} API calls per ${interval} seconds. %s`
    )
    return new RequestRateLimiter({
        backoffTime,
        requestRate,
        interval,
        timeout,
    })
}

async function getUserToken() {
    const userTokenDebug = debug("userToken")
    userTokenDebug("Retrieving MB user token")
    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/x-www-form-urlencoded")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", SITE_ID)

    const urlencoded = new URLSearchParams()
    urlencoded.append("Username", SITEOWNER)
    urlencoded.append("Password", PASSWORD)

    const requestOptions: any = {
        method: "POST",
        headers: myHeaders,
        body: urlencoded,
        redirect: "follow",
    }

    try {
        const response = await limiter.request({
            url: `${MB_API_BASE_URL}/usertoken/issue`,
            init: requestOptions,
        } as RequestConfig)
        const json = await response.json()
        const token = json.AccessToken
        userTokenDebug("Have MB user token %s.", token)
        return token
    } catch (error) {
        userTokenDebug("Failed to retrieve MB user token %o", error)
    }
}

function getAudience() {
    mainDebug("Opening opted-out clients CSV %s", "getAudience")
    try {
        const readable = fs.createReadStream(AUDIENCE_CSV)
        mainDebug("Opening opted-out clients CSV completed. %s", "getAudience")
        return readable
    } catch (error) {
        mainDebug("Opening opted-out clients CSV failed %o", error)
    }
}

async function getClients(accessToken: string, offset: number) {
    const getClientsDebug = debug("getClients")
    getClientsDebug(
        `Retrieving ${MAX_CLIENT_REQ} MB clients from offset ${offset}`
    )
    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", SITE_ID)
    myHeaders.append("Authorization", accessToken)

    const urlencoded = new URLSearchParams()
    urlencoded.append("Username", SITEOWNER)
    urlencoded.append("Password", PASSWORD)

    const init: any = {
        method: "GET",
        headers: myHeaders,
        redirect: "follow",
    }

    const response = await limiter.request({
        url: `${MB_API_BASE_URL}/client/clients?limit=${MAX_CLIENT_REQ}&offset=${offset}&searchText=`,
        init: init,
    } as RequestConfig)
    const json = await response.json()
    if (Object.prototype.hasOwnProperty.call(json, "Error")) throw json
    const clients: Client[] = json.Clients
    return new Promise<Client[]>((resolve) => {
        getClientsDebug(
            `Retrieved ${clients.length} clients from offset ${offset} %s`
        )
        resolve(clients)
    })
}

async function getEmails() {
    const readableAudience = getAudience()
    const rl = readline.createInterface(readableAudience!)
    const emails = new Set<string>()
    let firstLine = true
    rl.on("line", (line) => {
        const email = line.split(",", 10)[EMAIL_COLUMN - 1]
        if (firstLine && CSV_HAS_HEADER) {
            firstLine = false
        } else {
            emails.add(email)
        }
    })
    return new Promise<Set<string>>((resolve) => {
        rl.on("close", () => {
            resolve(emails)
        })
    })
}
/**
 * @param accessToken Auth token to access MB REST API
 * @param clientID Client ID
 * @param optOut Whether to opt the client out of marketing emails
 */
async function updateClientOptInStatus(
    accessToken: string,
    client: Client,
    optOut: boolean
): Promise<string> {
    const optInStatusDebug = debug("optInStatus")

    /* // sanitize phone numbers
    client.HomePhone = client.HomePhone ? client.HomePhone.trim() : null
    client.WorkPhone = client.WorkPhone ? client.WorkPhone.trim() : null
    client.MobilePhone = client.MobilePhone ? client.MobilePhone.trim() : null

    // sanitize email address
    client.Email = client.Email ? client.Email.trim() : null */

    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", SITE_ID)
    myHeaders.append("Authorization", accessToken)

    const raw = JSON.stringify({
        Client: {
            Id: client.Id,
            SendAccountEmails: true,
            SendAccountTexts: true,
            SendPromotionalEmails: !optOut,
            // Does nothing - you can't change the settings for texts via the API
            SendPromotionalTexts: !optOut,
            SendScheduleEmails: true,
            SendScheduleTexts: true,
        },
        CrossRegionalUpdate: false,
        Test: MB_API_TEST_FLAG,
    })

    const init: any = {
        method: "POST",
        headers: myHeaders,
        body: raw,
        redirect: "follow",
    }

    return new Promise<string>((resolve, reject) => {
        try {
            limiter
                .request({
                    url: `${MB_API_BASE_URL}/client/updateclient`,
                    init: init,
                } as RequestConfig)
                .then((response) => {
                    response.json().then((result: any) => {
                        if (isWrappedMBError(result)) {
                            // We assume result is an object containing a single Error property
                            reject(result.Error)
                            return
                        }

                        if (isWrappedClient(result)) {
                            const client = result.Client
                            // following is obsolete?
                            if (client === undefined) {
                                throw new Error(`updatedClient is undefined.`)
                            }
                            if (client.Action !== "Updated") {
                                reject(
                                    `Client ${client.Id} ${client.FirstName} ${client.LastName} failed to update.`
                                )
                            }
                            if (optOut) { optInStatusDebug("Opted out %s.", client.Id) }
                            resolve(`${client.Id}: ${client.Action}`)
                        }
                        // should never reach here
                        reject(`Invalid result from fetch: ${result}`)
                    })
                })
        } catch (error) {
            reject(error)
        }
    })
} // end function optInClient()

// type guard using assertion
function isWrappedMBError(result: any): result is WrappedMBError {
    return (result as WrappedMBError).Error !== undefined
}

function isWrappedClient(result: any): result is WrappedClient {
    return (result as WrappedClient).Client !== undefined
}

async function updateClients(
    /*
    TODO look into more granular opt-out e.g. only opt-out from marketing
    but keep transactional emails
    */
    accessToken: string,
    clients: Client[],
    optOutEmails: Set<string>,
    batchId = "<None>"
): Promise<updateClientsResult> {
    /*     const updateClientsDebug = debug("updateClients")
        const failedUpdateDebug = debug("failedClientUpdate")
        const clientReviewDebug = debug("reviewClients") */
    let optedInCount = 0
    let updateFailCount = 0
    let optedOutCount = 0
    for (const client of clients) {
        // optOutEmails is all the user who have opted out via MailChimp
        let optOut = false
        optOut = checkEmailOptOut(client, optOutEmails)
        optOut = checkNotesOptOut(client)
        try {
            await updateClientOptInStatus(accessToken, sanitizeClient(cloneable.deepCopy(client)), optOut)
            if (optOut) {
                optedOutCount += 1
            } else {
                // updateClientsDebug("Opted in %s %s %s", client.Id, client.FirstName, client.LastName)
                optedInCount += 1
            }
        } catch (error) {
            failedUpdateDebug(`Client update failed %o`, error)
            updateFailCount += 1
            const writeSuccess = bad_clients.write(`${JSON.stringify(error)}\n`)
            if (!writeSuccess) {
                failedUpdateDebug(
                    `Failed to write to file: ${bad_clients.path}`
                )
            }
        }
        clientsProcessed += 1
        if (clientsProcessed % 100 == 0) {
            globalStatsDebug(
                "%d of %d clients processed",
                clientsProcessed,
                clientsRetrieved
            )
        }
    }
    updateClientsDebug(
        `Batch ${batchId}: Opted-in: %d, Opted-out: %d, Failed to update: %d`,
        optedInCount,
        optedOutCount,
        updateFailCount
    )
    // updateClientsDebug(`Opted-out: %d`, optedOutCount)
    // updateClientsDebug(`Failed to update: %d`, updateFailCount)
    return {
        optedInClients: optedInCount,
        optedOutClients: optedOutCount,
        updateFailedClients: updateFailCount,
    }
}

function checkEmailOptOut(client: Client, optOutEmails: Set<string>) {
    let optOut = false
    const Email = client.Email?.trim() ?? null
    if (Email) {
        optOut = optOutEmails.has(Email)
        if (optOut) { clientReviewDebug("Opting out client %s %s %s due to presence of email (%s) in MailChimp CSV", client.Id, client.FirstName, client.LastName, Email) }
    }
    return optOut
}

function checkNotesOptOut(client: Client) {
    let optOut = false
    const Notes = client.Notes?.trim() ?? null
    if (Notes) {
        /*         const Id = client.Id
                const FirstName = client.FirstName
                const LastName = client.LastName */
        /* There's possibly a note saying don't send emails so play it safe */
        optOut = true
        clientReviewDebug("Opting out client %s %s %s due to presence of notes on file.", client.Id, client.FirstName, client.LastName)
        // const info = `${Id} ${FirstName} ${LastName} notes are: ${Notes.substr(0,20)}`
        // clientReviewDebug(info)
        // TODO make the file updates asynchronous
        const writeSuccess = review_clients.write(`Opting out client ${client.Id} ${client.FirstName} ${client.LastName} due to presence of notes on file.\n`)
        if (!writeSuccess) {
            failedUpdateDebug(
                `Failed to write ${client.Id} ${client.FirstName} ${client.LastName} to file: ${bad_clients.path}. Continuing anyway.`
            )
        }
    }
    return optOut
}

function sanitizeClient(client: Client) {
    client.FirstName = client.FirstName?.trim() ?? null
    client.LastName = client.LastName?.trim() ?? null
    client.HomePhone = client.HomePhone?.trim() ?? null
    client.WorkPhone = client.WorkPhone?.trim() ?? null
    client.MobilePhone = client.MobilePhone?.trim() ?? null
    client.Notes = client.Notes?.trim() ?? null
    return client
}

async function processClients() {
    const optOutEmails = await getEmails()
    const accessToken = await getUserToken()
    const updateClientPromises: Promise<updateClientsResult>[] = []
    mainDebug("Retrieving and updating clients.")
    for (
        let index = 0;
        index < MAX_CLIENTS_TO_PROCESS;
        index += MAX_CLIENT_REQ
    ) {
        try {
            const clients = await getClients(accessToken, index)
            if (!!clients && !(clients instanceof Error)) {
                clientsRetrieved += clients.length
                updateClientPromises.push(
                    updateClients(accessToken, clients, optOutEmails)
                )
                mainDebug(`Pushed in-flight batch at index %d`, index)
                if (clients.length == 0) {
                    mainDebug(`All %d clients retrieved.`, clientsRetrieved)
                    break
                }
            }
        } catch (error) {
            mainDebug(error)
        }
    }
    Promise.all(updateClientPromises)
        .then((result) =>
            mainDebug(`%d update client batches processed`, result.length)
        )
        .catch((error) =>
            mainDebug(`update clients batch update failed %O`, error)
        )
        .finally(() =>
            bad_clients.end(() => mainDebug("Closed bad clients file"))
        )
}

const mainDebug = debug("main")
const globalStatsDebug = debug("global-stats")
const updateClientsDebug = debug("updateClients")
const failedUpdateDebug = debug("failedClientUpdate")
const clientReviewDebug = debug("reviewClients")
const bad_clients = fs.createWriteStream(BAD_CLIENTS)
const review_clients = fs.createWriteStream(REVIEW_CLIENTS)
let clientsRetrieved = 0
let clientsProcessed = 0
const limiter = initLimiter()
limiter.setRequestHandler(new fetchRequestHandler())
processClients()
    .catch((error) => mainDebug(error as Error))
    .finally(() => { })
