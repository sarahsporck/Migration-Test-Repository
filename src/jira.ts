import JiraApi from 'jira-client'

const jiraClient = () => new JiraApi({
    protocol: 'https',
    host: 'issues.tuerantuer.org',
    bearer: process.env.JIRA_ACCESS_TOKEN,
    apiVersion: '2',
    strictSSL: true
})

export const getBoardIdByName = async (jira: JiraApi, name: string) => {
    const boards = await jira.getAllBoards(0, 100, undefined, "App-Team")
    if (boards.total !== 1) {
        throw Error("Board " + name + " either not found or other matching boards were found.")
    }
    return boards.values[0].id
}

export default jiraClient