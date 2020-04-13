/* email-opt-in */

// var unirest = require('unirest');
// import unirest from "unirest"
import fetch, { RequestInit, Headers } from "node-fetch"
import { URLSearchParams, URL } from "url"
import fs from "fs"
import readline from "readline"
import { once } from "events"
import { rejects } from "assert"

const MB_API_VER = 6
const MAX_CLIENT_REQ = 10 // in range 0 - 200
const AUDIENCE_CSV = "file:///D:/Downloads/unsubscribed_segment_export_8893817261.csv"
const CSV_HAS_HEADER = true
const API_TOKEN = "b46102a0d390475aae114962a9a1fbd9"
const SITE_ID = "-99"
const USERNAME = "siteowner"
const PASSWORD = "apitest1234"
const DEFAULT_EMAIL_COL = 1

interface Client {
    FirstName: string
    LastName: string
    Email: string
    Id: number
}

// Convenience function to allow await inside foreach
async function asyncForEach(array: any[], callback: (...args: any[]) => any) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array)
    }
}

async function getUserToken() {
    var myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/x-www-form-urlencoded")
    myHeaders.append("API-Key", "b46102a0d390475aae114962a9a1fbd9")
    myHeaders.append("SiteId", "-99")

    var urlencoded = new URLSearchParams()
    urlencoded.append("Username", "Siteowner")
    urlencoded.append("Password", "apitest1234")

    var requestOptions: RequestInit = {
        method: "POST",
        headers: myHeaders,
        body: urlencoded,
        redirect: "follow",
    }

    try {
        const response = await fetch(
            `https://api.mindbodyonline.com/public/v${MB_API_VER}/usertoken/issue`,
            requestOptions
        )
        const json = await response.json()
        const token = json.AccessToken
        // const token = (await response.json()).AccessToken
        return token
    } catch (error) {
        console.log("error", error)
    }
}

function getAudience() {
    try {
        const readable = fs.createReadStream(new URL(AUDIENCE_CSV))
        return readable
    } catch (error) {
        console.error(error)
    }
}

async function getClients(accessToken: string, offset: number) {
    let myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", "b46102a0d390475aae114962a9a1fbd9")
    myHeaders.append("SiteId", SITE_ID)
    myHeaders.append("Authorization", accessToken)

    var urlencoded = new URLSearchParams()
    urlencoded.append("Username", "Siteowner")
    urlencoded.append("Password", "apitest1234")

    let init: RequestInit = {
        method: "GET",
        headers: myHeaders,
        // body: urlencoded,
        redirect: "follow",
    }

    try {
        const response = await fetch(
            `https://api.mindbodyonline.com/public/v${MB_API_VER}/client/clients?limit=${MAX_CLIENT_REQ}&offset=${offset}&searchText=`,
            init
        )
        const json = await response.json()
        if (json.hasOwnProperty("Error")) throw new Error(json.Error.Message)
        const clients: Client[] = json.Clients
        return new Promise<Client[]>((resolve, reject) => {
            resolve(clients)
        })
    } catch (error) {
        return new Promise<Error>((resolve, reject) => {
            reject(error)
        })
    }
}

async function getEmails() {
    const readableAudience = getAudience()
    const rl = readline.createInterface(readableAudience!)
    let emails: string[] = []
    let firstLine = true
    rl.on("line", (line) => {
        let email = line.split(",", 10)[DEFAULT_EMAIL_COL - 1]
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

async function optInClient(accessToken: string, clientID: number) {
    let myHeaders = new Headers()
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("API-Key", "b46102a0d390475aae114962a9a1fbd9")
    myHeaders.append("SiteId", SITE_ID)
    myHeaders.append("Authorization", accessToken)

    let raw = JSON.stringify({
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

    let init: RequestInit = {
        method: "POST",
        headers: myHeaders,
        body: raw,
        redirect: "follow",
    }

    try {
        const response = await fetch(`https://api.mindbodyonline.com/public/v${MB_API_VER}/client/updateclient`, init)
        const result = await response.json()
        const updatedClient = result.Client
        if (updatedClient.Action !== "Updated") throw new Error(`Client ${result.Id} ${updatedClient.FirstName} ${updatedClient.LastName} failed to update.`)
        return new Promise<string>((resolve) => {
            resolve(`${updatedClient.Id}: ${updatedClient.Action}`)
        })
    } catch (error) {
        throw error
    }
}

async function optInAllClients(accessToken: string, clients: Client[]) {
    const updateClients = async () => {
        await asyncForEach(clients, (client) => {
          optInClient(accessToken, client.Id).then((result)=>console.log(result))
        })
    }
    updateClients()
}

function optOutClients() {}

async function main() {
    const emails = await getEmails()
    const accessToken = await getUserToken()
    try {
        const clients = await getClients(accessToken, 0)
        if (!!clients && !(clients instanceof Error)) {
            optInAllClients(accessToken, clients)
        }
        optOutClients()
    } catch (error) {
        console.error(error)
    }

    console.log("Done.")
}

main()
