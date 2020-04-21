/* email-opt-in */

// eslint-disable-next-line no-unused-vars
import fetch, { RequestInit, Headers } from "node-fetch"
import { URLSearchParams } from "url"
import fs from "fs"
import readline from "readline"
// import draftlog = require("draftlog")

const MB_API_VER = 6
const BASE_URL = `https://api.mindbodyonline.com/public/v${MB_API_VER}`
const MAX_CLIENTS_TO_PROCESS = 5000
const MAX_CLIENT_REQ = 100 // in range 0 - 200
//const AUDIENCE_CSV = "file:///D:/Downloads/unsubscribed_segment_export_8893817261.csv"
const AUDIENCE_CSV = "./data/unsubscribed_segment_export_8893817261.csv"
const CSV_HAS_HEADER = true
const API_TOKEN = "b46102a0d390475aae114962a9a1fbd9"
const SITE_ID = "-99"
const DEFAULT_EMAIL_COL = 1

interface Client {
    FirstName: string
    LastName: string
    Email: string
    Id: string
}

// TODO get draftlog working in Typescript
// Calculate the progress for a progress bar

async function getUserToken() {
    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/x-www-form-urlencoded")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", "-99")

    const urlencoded = new URLSearchParams()
    urlencoded.append("Username", "Siteowner")
    urlencoded.append("Password", "apitest1234")

    const requestOptions: RequestInit = {
        method: "POST",
        headers: myHeaders,
        body: urlencoded,
        redirect: "follow",
    }

    try {
        const response = await fetch(
            `${BASE_URL}/usertoken/issue`,
            requestOptions
        )
        const json = await response.json()
        const token = json.AccessToken
        return token
    } catch (error) {
        console.log("error", error)
    }
}

function getAudience() {
    try {
        const readable = fs.createReadStream(AUDIENCE_CSV)
        return readable
    } catch (error) {
        console.log(error)
    }
}

async function getClients(accessToken: string, offset: number) {
    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", SITE_ID)
    myHeaders.append("Authorization", accessToken)

    const urlencoded = new URLSearchParams()
    urlencoded.append("Username", "Siteowner")
    urlencoded.append("Password", "apitest1234")

    const init: RequestInit = {
        method: "GET",
        headers: myHeaders,
        // body: urlencoded,
        redirect: "follow",
    }

    const response = await fetch(
        `${BASE_URL}/client/clients?limit=${MAX_CLIENT_REQ}&offset=${offset}&searchText=`,
        init
    )
    const json = await response.json()
    if (Object.prototype.hasOwnProperty.call(json, "Error")) throw json
    const clients: Client[] = json.Clients
    return new Promise<Client[]>((resolve) => {
        resolve(clients)
    })
}

async function getEmails() {
    const readableAudience = getAudience()
    const rl = readline.createInterface(readableAudience!)
    const emails: string[] = []
    let firstLine = true
    rl.on("line", (line) => {
        const email = line.split(",", 10)[DEFAULT_EMAIL_COL - 1]
        if (firstLine && CSV_HAS_HEADER) {
            firstLine = false
        } else {
            emails.push(email)
        }
    })
    return new Promise<string[]>((resolve) => {
        rl.on("close", () => {
            resolve(emails)
        })
    })
}

async function optInClient(accessToken: string, clientID: string) {
    const myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", API_TOKEN)
    myHeaders.append("SiteId", SITE_ID)
    myHeaders.append("Authorization", accessToken)

    const raw = JSON.stringify({
        Client: {
            Id: clientID,
            SendAccountEmails: true,
            SendAccountTexts: true,
            SendPromotionalEmails: true,
            SendPromotionalTexts: true,
            SendScheduleEmails: true,
            SendScheduleTexts: true,
        },
        SendEmail: true,
        CrossRegionalUpdate: false,
        Test: false,
    })

    const init: RequestInit = {
        method: "POST",
        headers: myHeaders,
        body: raw,
        redirect: "follow",
    }

    return new Promise<string>((resolve, reject) => {
        try {
            fetch(`${BASE_URL}/client/updateclient`, init).then((response) => {
                response.json().then((result) => {
                    if (!response.ok) {
                        reject(
                            `Client update failed: Error is ${result.Error.Code}. Error message is ${result.Error.Message}`
                        )
                        return
                    }
                    const updatedClient = result.Client
                    if (updatedClient === undefined) {
                        throw new Error(`updatedClient is undefined.`)
                    }
                    if (updatedClient.Action !== "Updated") {
                        reject(
                            `Client ${result.Id} ${updatedClient.FirstName} ${updatedClient.LastName} failed to update.`
                        )
                    }
                    resolve(`${updatedClient.Id}: ${updatedClient.Action}`)
                })
            })
        } catch (error) {
            reject(error)
        }
    })
} // end function optInClient()

async function optInClients(accessToken: string, clients: Client[]) {
    let successCount = 0
    for (const client of clients) {
        try {
            await optInClient(accessToken, client.Id)
            process.stdout.write(".")
            successCount += 1
        } catch (error) {
            console.log(`\n${error}`)
        }
    }
    return successCount
}

function optOutClients() {}

async function main() {
    // eslint-disable-next-line no-unused-vars
    const emails = await getEmails()
    const accessToken = await getUserToken()
    for (
        let index = 0;
        index <= MAX_CLIENTS_TO_PROCESS;
        index += MAX_CLIENT_REQ
    ) {
        try {
            const clients = await getClients(accessToken, index)
            if (!!clients && !(clients instanceof Error)) {
                //console.debug(`\n${clients.length} clients retrieved.`)
                if (clients.length === 0) {
                    console.log(`\nAll clients retrieved.`)
                    break
                }
                process.stdout.write("C")
                // TODO should optInAllClients return a value? What value? Tuple containing Error and Status?
                optInClients(accessToken, clients)
                    .then((successCount) =>
                        console.log(
                            `\nIndex:${index}: ${successCount} clients opted-in.`
                        )
                    )
                    .catch((error) => {
                        throw error
                    })
            }
        } catch (error) {
            console.log(error)
        }
    }
    optOutClients()
}

main().catch((error) => console.log(error as Error))
console.log("Done.")
