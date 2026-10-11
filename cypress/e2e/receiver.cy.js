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
    cy.contains('Servers')
    cy.contains('No recent activity').should('not.exist') // "Client ready" is logged on mount
  })

  it('disables push-to-talk until connected', () => {
    cy.get('button[aria-label*="Push to talk"]').should('be.disabled')
    cy.contains('Connect to a server to talk')
  })

  it('shows no receiving indicator when nobody is transmitting', () => {
    cy.get('[role="status"]').should('not.exist')
  })

  it('lists servers in the sidebar and can add one', () => {
    cy.get('input[aria-label="Add server host"]').first().type('sidebar.example.test{enter}')
    cy.get('.sidebar, aside').should('contain.text', 'sidebar.example.test')
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
    cy.contains('button', 'Luke').click()
    cy.get('input[aria-label="Display name"]').clear()
    cy.get('input[aria-label="Display name"]').type('Control{enter}')
    cy.get('button[aria-label="Account menu"]').should('contain.text', 'Control')
  })

  it('ships an installable web app manifest', () => {
    cy.get('link[rel="manifest"]').should('exist')
  })
})
