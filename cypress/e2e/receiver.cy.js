// https://on.cypress.io/api

describe('PTToX client shell', () => {
  beforeEach(() => {
    cy.visit('/', {
      onBeforeLoad(win) {
        win.localStorage.clear()
      },
    })
  })

  it('renders the three panes with an idle, disconnected state', () => {
    cy.contains('h1', 'Push to Talk')
    cy.contains('Status').parent().should('contain.text', 'Disconnected')
    // The three panes: talkgroups, the stage, and the right rail. Servers are
    // not among them — they live in the header dropdown, not the sidebar.
    cy.contains('Groups')
    cy.contains('Log')
    cy.contains('No recent activity').should('not.exist') // "Client ready" is logged on mount
  })

  it('disables push-to-talk until connected', () => {
    cy.get('button[aria-label*="Push to talk"]').should('be.disabled')
    cy.contains('Connect to a server to talk')
  })

  it('shows no receiving indicator when nobody is transmitting', () => {
    cy.get('[role="status"]').should('not.exist')
  })

  it('lists talkgroups in the sidebar and can add one', () => {
    // The sidebar holds groups. Adding a server is covered by the header menu
    // test below, which is where servers actually live.
    cy.get('input[aria-label="Add group"]').type('PMR-1{enter}')
    cy.get('.sidebar, aside').should('contain.text', 'PMR-1')
  })

  it('lets the operator pick a server from the header menu', () => {
    cy.get('button[aria-label="Select server"]').click()
    cy.contains('Available servers')
    cy.get('input[aria-label="Add server host"]').type('pttox.example.test{enter}')
    cy.get('button[aria-label="Select server"]').should('contain.text', 'pttox.example.test')
  })

  it('persists the chosen server across a reload', () => {
    cy.get('button[aria-label="Select server"]').click()
    cy.get('input[aria-label="Add server host"]').type('persisted.example.test{enter}')
    cy.reload()
    cy.get('button[aria-label="Select server"]').should('contain.text', 'persisted.example.test')
  })

  it('records and clears activity log entries', () => {
    cy.contains('Client ready')
    cy.contains('button', 'Clear log').click()
    cy.contains('No recent activity')
  })

  it('renames the operator from the account menu', () => {
    cy.get('button[aria-label="Account menu"]').click()
    // Scoped to the menu: the trigger button also carries the display name, and
    // an unscoped match hits that first and closes the menu again.
    cy.get('button.menu__item').contains('Luke').click()
    cy.get('input[aria-label="Display name"]').clear()
    cy.get('input[aria-label="Display name"]').type('Control{enter}')
    cy.get('button[aria-label="Account menu"]').should('contain.text', 'Control')
  })

  it('ships an installable web app manifest', () => {
    cy.get('link[rel="manifest"]').should('exist')
  })
})
