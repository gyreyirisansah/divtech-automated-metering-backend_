const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const rdb = admin.database();

var months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthNumToName(monthnum) {
  return months[monthnum - 1] || "";
}
function monthNameToNum(monthname) {
  var month = months.indexOf(monthname);
  return month ? month + 1 : 0;
}

const calculatebill = (energy) => {
  var bill;
  if (energy < 51) {
    bill = 0.30778 * curr;
  } else if ((energy == 51 || energy > 51) && energy < 301) {
    let _firstphasebill = 0.30778 * 50;
    let _remainingbill = 0.617488 * (energy - 50);
    bill = _firstphasebill + _remainingbill;
  } else if ((energy == 301 || energy > 301) && energy < 601) {
    let _firstphasebill = 0.30778 * 50 + 0.617488 * 250;
    let _remainingbill = 0.80138 * (energy - 300);
    bill = _firstphasebill + _remainingbill;
  } else if (energy > 601) {
    let _firstphasebill = 0.30778 * 50 + 0.617488 * 250 + 0.80138 * 300;
    let _remainingbill = 0.890422 * (energy - 600);
    bill = _firstphasebill + _remainingbill;
  }
  return bill;
};

const prepaidUnitsConversion = (amount) => {
  var units;
  if (amount < 16) {
    units = amount / 0.30778;
  } else if ((amount == 16 || amount > 16) && amount < 171) {
    let _firstphaseunits = 15 / 0.30778;
    let _remainingunits = (amount - 15) / 0.617488;
    units = _firstphaseunits + _remainingunits;
  } else if (
    ((amount == 171 || amount > 171) && amount < 410) ||
    amount == 410
  ) {
    let _firstphaseunits = 15 / 0.30778 + 155 / 0.617488;
    let _remainingunits = (amount - 170) / 0.80138;
    units = _firstphaseunits + _remainingunits;
  } else if (amount > 410) {
    let _firstphaseunits = 15 / 0.30778 + 155 / 0.617488 + 240 / 0.80138;
    let _remainingunits = (amount - 410) / 0.890422;
    units = _firstphaseunits + _remainingunits;
  }
  return units;
};

exports.onConsumption = functions.database
  .ref("/meters/{meterId}/energy")
  .onWrite((change, context) => {
    var mode;
    const energy = change.after.val();
    var meterId = context.params.meterId;
    change.after.ref.parent.child("mode").once("value", (data) => {
      mode = data.val();
    });

    var notificationToken;

    rdb.ref(`consumers/${meterId}/notificationToken`).once("value", (data) => {
      notificationToken = data.val();
    });

    if (mode == "Prepaid") {
      var balance;
      change.after.ref.parent.child("balance").once("value", (data) => {
        balance = data.val();
        balance = balance - energy;
      });

      return change.after.ref.parent
        .child("balance")
        .set(balance)
        .then(() => {
          if (balance == 9) {
            const payload = {
              notification: {
                title: "Low Balance",
                body:
                  "Your balance is less than 10 units, kindly recharge before you power switch off",
              },
            };
            return admin.messaging().sendToDevice(notificationToken, payload);
          }

          if (balance == 4.0) {
            const payload = {
              notification: {
                title: "Low Balance",
                body:
                  "Your balance is less than 5 units, kindly recharge before you power switch off",
              },
            };
            return admin.messaging().sendToDevice(notificationToken, payload);
          }
          if (balance == 1.0) {
            const payload = {
              notification: {
                title: "Low Balance",
                body:
                  "Your balance is less than 1 units, Your power would be going off in short time, kindly recharge.",
              },
            };
            return admin.messaging().sendToDevice(notificationToken, payload);
          }

          if (balance == 0.0) {
            const shutdowndata = {
              status: "off",
              controller: 3,
              shutdowntime: new Date().toISOString(),
            };
            return change.after.ref.parent
              .child(`${meterId}`)
              .update(shutdowndata)
              .then(() => {
                const payload = {
                  notification: {
                    title: "Out of Balance",
                    body: "You have run out balance. Recharge",
                  },
                };

                return admin
                  .messaging()
                  .sendToDevice(notificationToken, payload);
              });
          }
        });
    } else if (mode == "Postpaid") {
      const bill = calculatebill(energy);
      return change.after.parent.child.bill("bill").set(bill);
    }
    return;
  });

exports.onMeterReconnection = functions.database
  .ref("/meters/{meterId}/status")
  .onWrite((change, context) => {
    const status = change.after.val();
    const meterId = context.params.meterId;
    var controller;
    var mode;
    var points;
    change.after.ref.parent.child("controller").once("value", (data) => {
      controller = data.val();
    });

    change.after.ref.parent.child("mode").once("value", (data) => {
      mode = data.val();
    });

    change.after.ref.parent.child("points").once("value", (data) => {
      points = data.val();
    });

    if (status === "on" && controller == 4) {
      if (mode == "Prepaid") {
        var shutdowntime;
        change.after.ref.parent.child("shutdowntime").once("value", (data) => {
          shutdowntime = new Date(data.val());
        });
        var currentTime = new Date();
        var timeElapsedDuringShutdown =
          (currentTime.getTime() - shutdowntime.getTime()) / 3600000;
        const pointsToDeduct = Math.floor(timeElapsedDuringShutdown / 4.8);
        points = points - pointsToDeduct;
        return change.after.ref.parent.child("points").set(points);
      } else if (mode == "Postpaid") {
        var bill;
        var balancebroughtForwardFromPostpaid;
        change.after.ref.parent.child("bill").once("value", (data) => {
          bill = data.val();
        });
        if (bill < 0) {
          bill = Math.abs(bill);
          balancebroughtForwardFromPostpaid = prepaidUnitsConversion(bill);
        } else {
          balance = 0;
        }
        const additionalUserData = {
          balance: balancebroughtForwardFromPostpaid,
          mode: "Prepaid",
        };
        return change.after.ref.parent
          .child(`${meterId}`)
          .update(additionalUserData)
          .then(() => {
            return rdb.ref(`consumers/${meterId}/mode`).set("Prepaid");
          })
          .then(() => {
            var notificationToken;
            rdb
              .ref(`consumers/${meterId}/notificationToken`)
              .once("value", (data) => {
                notificationToken = data.val();
              });
            const payload = {
              notification: {
                title: "Mode Switched",
                body:
                  "Your mode have been switched from prepaid to postpaid due to inconsistency in bill payment, You would be able to switch back to postpaid after you have built for yourself the required trust.",
              },
            };

            return admin.messaging().sendToDevice(notificationToken, payload);
          });
      }
    }
  });

exports.onPayment = functions.database
  .ref("/payments/{paymentId}")
  .onWrite((change, context) => {
    var paymentDetails = change.after.val();
    var amountPaid = paymentDetails.amountPaid;
    var meterId = paymentDetails.meterId;
    var meterDetails;
    var notificationToken;

    rdb.ref(`meters/${meterId}`).once("value", (data) => {
      meterDetails = data.val();
    });

    rdb.ref(`consumers/${meterId}/notificationToken`).once("value", (data) => {
      notificationToken = data.val();
    });

    if (meterDetails.mode == "Prepaid") {
      var balance = meterDetails.balance;
      energyBought = prepaidUnitsConversion(amountPaid);
      balance = balance + energyBought;
      return rdb
        .ref(`meters/${meterId}/balance`)
        .set(balance)
        .then((data) => {
          const payload = {
            notification: {
              title: "Balance Recharge",
              body: `You have successfully recharged ${energyBought} kW/h for meter ${meterId}. Your currnet balance is ${balance}.`,
            },
          };
          admin.messaging().sendToDevice(notificationToken, payload);
        });
    } else if (meterDetails.mode == "Postpaid") {
      curDate = new Date();
      const currentMonth = monthNumToName(curDate.getMonth() + 1);
      const previousMonth = monthNumToName(curDate.getMonth());
      const currentYear = Date.getFullYear();
      var previousMonthDetails;
      rdb
        .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
        .once("value", (data) => {
          previousMonthDetails = data.val();
        });

      if (previousMonthDetails.bill - previousMonthDetails.amountPaid > 0) {
        if (
          previousMonthDetails.bill - amountPaid > 0 ||
          previousMonthDetails.bill - amountPaid == 0
        ) {
          rdb
            .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
            .amountPaid.set(amountPaid)
            .then(() => {
              const payload = {
                notification: {
                  title: "Bill Payment",
                  body: `You have successfully paid ${amountPaid} GHS for meter ${meterId} for the  month of  ${previousMonth}.`,
                },
              };
              return admin.messaging().sendToDevice(notificationToken, payload);
            });
        } else {
          var previousMonthBill = previousMonthDetails.bill;
          var currentMonthBillPaid = amountPaid - amountPaid;
          return rdb
            .ref(`readingStats/${meterId}/${currentYear}/${previousMonth}`)
            .amountPaid.set(previousMonthBill)
            .then(() => {
              rdb
                .ref(`readingStats/${meterId}/${currentYear}/${currentMonth}`)
                .amountPaid.set(currentMonthBillPaid);
            })
            .then(() => {
              const payload = {
                notification: {
                  title: "Bill Payment",
                  body: `You have successfully paid ${previousMonthBill} GHS for the  month of  ${previousMonth} and  ${currentMonthBillPaid} GHS for the  month of  ${currentMonth} for meter ${meterId}.`,
                },
              };
              return admin.messaging().sendToDevice(notificationToken, payload);
            });
        }
      }
    }
  });

// exports.onBilling = functions.database
//   .ref("/meters/{meterId}/bill")
//   .onWrite((change, context) => {
//     var currentBill = change.after.val();
//     var payments;
//     var metId;
//     change.after.ref.parent
//       .child("meterId")
//       .once("value")
//       .then((snapShot) => {
//         metId = snapShot.val();
//       });

//     rdb
//       .ref("/payments")
//       .orderByChild("meterId")
//       .equalTo("DT10001")
//       .once("value", (data) => {
//         if (data.val() != null) {
//           var sumOfPayments = 0;
//           data.forEach((payments) => {
//             sumOfPayments += payments.amountPaid;
//           });
//           payments = sumOfPayments / data.numChildren();
//         }
//       });

//     if (currentBill > payments) {
//       change.after.ref.parent.child("controller").set(3);
//       return change.after.ref.parent.child("status").set("off");
//     } else {
//       return null;
//     }
//   });
