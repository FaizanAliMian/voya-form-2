import { Permissions, webMethod } from 'wix-web-module';
 
import { contacts, triggeredEmails } from 'wix-crm-backend';

export const findAndEmailContact = webMethod(Permissions.Anyone, async (emailToFind, emailId) => {
  try {
    // Query the contacts for the specific email address
    // Reference: https://dev.wix.com/docs/velo/apis/wix-crm-backend/contacts/sort-filter-and-search
    const queryResults = await contacts.queryContacts()
      .eq('info.emails.email', emailToFind)
      .find();

    const contactsWithEmail = queryResults.items;

    if (contactsWithEmail.length > 0) {
      // Retrieve the contactId from the first matching item
      const contactId = contactsWithEmail[0]._id;
      console.log('Found contact ID:', contactId);

      // Send the triggered email using the retrieved contactId
      // Reference: https://dev.wix.com/docs/velo/apis/wix-crm-backend/triggered-emails/email-contact
      await triggeredEmails.emailContact(emailId, contactId);
      return { success: true, contactId };
    } else {
      console.log('No contacts found with that email.');
      return { success: false, message: 'No contact found' };
    }
  } catch (error) {
    console.error('Error in findAndEmailContact:', error);
    throw error;
  }
});