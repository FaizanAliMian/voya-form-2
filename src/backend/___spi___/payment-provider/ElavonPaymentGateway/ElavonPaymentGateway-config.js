// import * as paymentProvider from 'interfaces-psp-v1-payment-service-provider';

// /** @returns {import('interfaces-psp-v1-payment-service-provider').PaymentServiceProviderConfig} */
export function getConfig() {
    return {
        title: "Elavon",
        paymentMethods: [{
            hostedPage: {
                title: "Fast Online Payments (BLIK, Cards, Apple Pay)",
                billingAddressMandatoryFields: [],
                logos: {
                    white: {
                        svg: "https://static.wixstatic.com/shapes/2fbbf4_52e2f431465a415da306a180ef1c7694.svg",
                        png: "https://static.wixstatic.com/media/2fbbf4_923555e93a494db9883e9fff307c1a05~mv2.png"
                    },
                    colored: {
                        svg: "https://static.wixstatic.com/shapes/2fbbf4_52e2f431465a415da306a180ef1c7694.svg",
                        png: "https://static.wixstatic.com/media/2fbbf4_923555e93a494db9883e9fff307c1a05~mv2.png"
                    }
                }
            }
        }],
        credentialsFields: [{
                simpleField: {
                    name: "username",
                    label: "Elavon API Username"
                }
            },
            {
                simpleField: {
                    name: "secret",
                    label: "Elavon API Secret"
                }
            },
            {
                simpleField: {
                    name: "merchantId",
                    label: "Elavon Merchant ID"
                }
            }
        ]
    };
}