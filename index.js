const chalk = require('chalk')
const BigNumber = require('bignumber.js')
const { request, gql } = require('graphql-request')
const tableify = require('tableify')
const cloneDeep = require('lodash.clonedeep')

const GRAPHQL_ENDPOINT = 'https://hub.snapshot.org/graphql'
const PROPOSAL_ID = '0xae009d3fc6517df8d2761a891be63a8a459e68e54d0b8043de176070a23ac51c'
const PAGE_SIZE = 1000
const OUR_BRIBED_CHOICE = 'WBTC (Arbitrum)'
const QI_BRIBE_PER_ONE_PERCENT = BigNumber(1000)
const WHALE_THRESHOLD = 250000
const WHALE_REDISTRIBUTION = 20
const TETU_ADDRESS = '0x0644141dd9c2c34802d28d334217bd2034206bf7'
// const TOTAL_WEEKLY_QI = BigNumber(180000)

function shouldClawBackWhale (address, voterVp) {
  if (address.toLowerCase() === TETU_ADDRESS) return false
  return BigNumber(voterVp).gt(WHALE_THRESHOLD)
}

function choiceToChain (choice) {
  return choice.split('(')[1].split(')')[0]
}

function logSection (name) {
  if (process.env.NODE_ENV === 'development') {
    console.log('')
    console.log(chalk.blue.underline(name))
    console.log('')
  } else {
    const loading = document.getElementById('loading')
    if (loading) loading.parentNode.removeChild(loading)
    const node = document.createElement('h4')
    node.appendChild(document.createTextNode(name))
    document.body.appendChild(node)
  }
}

function logText (text) {
  if (process.env.NODE_ENV === 'development') {
    console.log(text)
  } else {
    const node = document.createElement('p')
    node.appendChild(document.createTextNode(text))
    document.body.appendChild(node)
  }
}

function logTable (data) {
  data = cloneDeep(data)

  // format numbers, etc
  if (Array.isArray(data)) {
    for (const i in data) {
      for (const [k, v] of Object.entries(data[i])) {
        if (v instanceof BigNumber) {
          data[i][k] = v.toFixed(2)
        }
      }
    }
  } else {
    for (const [k, v] of Object.entries(data)) {
      if (v instanceof BigNumber) {
        data[k] = v.toFixed(2)
      }

      for (const [y, z] of Object.entries(v)) {
        if (z instanceof BigNumber) {
          v[y] = z.toFixed(2)
        }
      }
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.table(data)
  } else {
    const node = document.createElement('div')
    node.innerHTML = tableify(data)
    document.body.appendChild(node)
  }
}

async function getAllVotes () {
  const votes = []

  let i = 0
  while (true) {
    const resp = await request(GRAPHQL_ENDPOINT, gql`
      query {
        votes (
          first: ${PAGE_SIZE}
          skip: ${i * PAGE_SIZE}
          where: {
            proposal: "${PROPOSAL_ID}"
          }
          orderBy: "created",
          orderDirection: desc
        ) {
          id
          voter
          vp
          created
          choice
        }
      }
    `)
    votes.push(...resp.votes)

    if (resp.votes.length === PAGE_SIZE) {
      i++
    } else {
      break
    }
  }

  return votes
}

async function getProposalChoices () {
  const proposalResp = await request(GRAPHQL_ENDPOINT, gql`
    query {
      proposals (
        where: {
          id: "${PROPOSAL_ID}"
        }
      ) {
        id
        title
        body
        choices
        start
        end
        snapshot
        state
        scores
        scores_by_strategy
        scores_total
        scores_updated
        author
        space {
          id
          name
        }
      }
      }
  `)

  return ['', ...proposalResp.proposals[0].choices] // starts at idx = 1
}

async function main () {
  // Get subgraph data
  const choicesDict = await getProposalChoices()
  const votes = await getAllVotes()

  // Set these up for later
  let ourChoicePercentage
  let ourChoiceVotes

  // Calculate vote totals
  const voteTotals = {}
  for (const vote of votes) {
    const totalWeight = BigNumber.sum(...Object.values(vote.choice))

    for (const [choiceId, weight] of Object.entries(vote.choice)) {
      if (!voteTotals[choiceId]) voteTotals[choiceId] = BigNumber(0)
      voteTotals[choiceId] = BigNumber.sum(voteTotals[choiceId], BigNumber(vote.vp).times(BigNumber(weight)).div(totalWeight))
    }
  }

  const totalVote = BigNumber.sum(...Object.values(voteTotals))

  const totalsArr = []
  const percentagesByChain = {}

  for (const [choiceId, sumVotes] of Object.entries(voteTotals)) {
    const percentage = sumVotes.div(totalVote).times(100)
    const chain = choiceToChain(choicesDict[choiceId])

    totalsArr.push({
      choice: choicesDict[choiceId],
      votes: sumVotes,
      percentage: percentage
    })

    if (choicesDict[choiceId] === OUR_BRIBED_CHOICE) {
      ourChoiceVotes = sumVotes
      ourChoicePercentage = percentage
    }

    if (!percentagesByChain[chain]) percentagesByChain[chain] = BigNumber(0)
    percentagesByChain[chain] = BigNumber.sum(percentagesByChain[chain], percentage)
  }

  totalsArr.sort((a, b) => BigNumber(a.votes).gt(b.votes) ? -1 : 1)

  logSection(chalk.blue.underline('Current vote totals'))
  logTable(totalsArr)

  // Display chain percentages in descending order
  const percentagesByChainArr = []
  for (const [chain, p] of Object.entries(percentagesByChain)) {
    percentagesByChainArr.push([chain, p])
  }
  percentagesByChainArr.sort((a, b) => BigNumber(a[1]).gt(b[1]) ? -1 : 1)
  logSection(chalk.blue.underline('Vote totals by chain'))
  logTable(percentagesByChainArr)

  // Check that our chain has > 8.33% of vote
  const ourBribedChain = choiceToChain(OUR_BRIBED_CHOICE)
  if (percentagesByChain[ourBribedChain].lt('8.333')) {
    throw new Error(`no bribes, ${ourBribedChain} did not cross threshold`)
  }

  // Figure out how much bribe we are paying based on the % of vote that we got
  const totalBribe = BigNumber(ourChoicePercentage).times(QI_BRIBE_PER_ONE_PERCENT)
  const bribes = {}

  // Calculate bribes for each voter
  for (const vote of votes) {
    if (vote.vp === 0) continue

    const totalWeight = BigNumber.sum(...Object.values(vote.choice))

    for (const [choiceId, weight] of Object.entries(vote.choice)) {
      if (choicesDict[choiceId] === OUR_BRIBED_CHOICE) {
        const choiceVote = BigNumber(vote.vp).times(BigNumber(weight)).div(totalWeight)
        const percentageOfChoiceVote = choiceVote.div(ourChoiceVotes).times(100)
        const bribe = BigNumber(totalBribe).times(percentageOfChoiceVote).div(100)
        bribes[vote.voter] = {
          voterVp: vote.vp,
          choicePerc: percentageOfChoiceVote,
          bribeAmount: bribe
        }
      }
    }
  }

  // "Claw back" whale bribes
  let clawedBackWhaleBribeAmount = BigNumber(0)
  for (const i in bribes) {
    if (shouldClawBackWhale(i, bribes[i].voterVp)) {
      clawedBackWhaleBribeAmount = BigNumber.sum(clawedBackWhaleBribeAmount, bribes[i].bribeAmount)
    }
  }

  // Redistribute whale bribes to non-whales
  for (const i in bribes) {
    if (!shouldClawBackWhale(i, bribes[i].voterVp)) {
      bribes[i].whaleAdjust = BigNumber(bribes[i].choicePerc).times(clawedBackWhaleBribeAmount).times(WHALE_REDISTRIBUTION).div(100).div(100)
    } else {
      bribes[i].whaleAdjust = BigNumber(0).minus(bribes[i].bribeAmount)
    }

    bribes[i].totalBribe = BigNumber.sum(bribes[i].bribeAmount, bribes[i].whaleAdjust)
    bribes[i].qiPerPercent = BigNumber(bribes[i].totalBribe).div(BigNumber(bribes[i].choicePerc).times(ourChoicePercentage).div(100))
  }

  // Calculate total bribes
  const sumBribes = BigNumber.sum(...Object.values(bribes).map(b => b.totalBribe))

  logSection(chalk.blue.underline('Clawed back whale bribes'))
  logText(`${clawedBackWhaleBribeAmount.toFixed(2)} QI`)

  logSection(chalk.blue.underline('Our bribes'))
  logText(`${sumBribes.toFixed(2)} QI`)

  logSection(chalk.blue.underline('Bribes by voter'))
  logTable(bribes)
}

main()
